import type {
  TuiActiveRunControlPort,
  TuiInspectionPort,
  TuiQueuePort,
  TuiQueuedMessage,
  TuiRuntimeEvent,
  TuiRuntimeEventPort,
  TuiSessionTurnPort,
} from '../../../runtime/port.js';
import type { TuiStreamEvent } from '../../../runtime/stream-events.js';
import type { ExecResultError } from '../../../application/exec-result.js';
import type {
  TuiQueueUpdatedEvent,
  TuiSessionCatalogEvent,
  TuiSessionLifecycleEvent,
  TuiLlmRetryEvent,
} from '../../../types/runtime-events.js';
import type { TuiRunProjection } from '../../state/run-projection.js';
import { selectActiveSessionView } from '../../state/selectors.js';
import type { TuiEffectRunner, TuiStateStore } from '../../state/store.js';
import type { TranscriptStore } from '../../transcript/store.js';
import { consumeReconciledEventStream } from './event-stream-reconciliation.js';
import type { TuiActiveRunFlow } from '../run/active-run-flow.js';
import type { TuiChatController } from '../chat-controller.js';
import type { TuiInteractionFlow } from '../interaction/interaction-flow.js';
import type { TuiRuntimeStateCoordinator } from './runtime-state-coordinator.js';
import type { TuiSessionFlow } from '../session-flow.js';
import type { TuiDelegationFlow } from '../delegation-flow.js';
import type { TuiGoalFlow } from '../product/goal-flow.js';
import { delayWithAbort } from '../support.js';
import {
  captureTuiIncidentBestEffort,
  noopTuiObservability,
  type TuiIncidentSink,
  type TuiObservability,
} from '../../../observability/index.js';
import { formatTuiRuntimeFailure, resolveTuiRuntimeFailure } from './runtime-error-presentation.js';
import {
  shouldNotifyMcodeTurnComplete,
  type TuiTerminalNotificationKind,
} from '../../platform/terminal-notifications.js';
import { formatTuiActionFailure, tuiErrorDiagnostic } from '../../../user-facing-failure.js';

const EVENT_BUS_RECONNECT_BASE_DELAY_MS = 250;
const EVENT_BUS_RECONNECT_MAX_DELAY_MS = 10_000;
// One recovered process-local event-loop failure is transient; a short burst is actionable.
const INCIDENT_RECONNECT_WINDOW_MS = 30_000;
const INCIDENT_RECONNECT_FAILURE_THRESHOLD = 3;
const TERMINAL_RECONCILIATION_TIMEOUT_MS = 2_000;

type AppendLocalCell = (content: string, kind?: 'final-summary' | 'warning' | 'error') => void;

type TuiRuntimeEventFlowRuntime = TuiRuntimeEventPort &
  TuiSessionTurnPort &
  Pick<TuiActiveRunControlPort, 'getActiveRun'> &
  Pick<TuiQueuePort, 'listQueuedMessages'> &
  Partial<Pick<TuiInspectionPort, 'watchSessionUsageCommits'>>;

export interface TuiRuntimeEventFlowOptions {
  readonly runtime: TuiRuntimeEventFlowRuntime;
  readonly controller: TuiChatController;
  readonly stateStore: TuiStateStore;
  readonly effectRunner: TuiEffectRunner;
  readonly stateCoordinator: TuiRuntimeStateCoordinator;
  readonly sessionFlow: Pick<TuiSessionFlow, 'reconcileRuntimeEvent'>;
  readonly delegationFlow: Pick<
    TuiDelegationFlow,
    'handleRuntimeEvent' | 'handleSettledRuntimeEvent' | 'refresh'
  >;
  readonly activeRunFlow: TuiActiveRunFlow;
  readonly interactionFlow: TuiInteractionFlow;
  readonly runProjection: TuiRunProjection;
  readonly releaseQueueItem: (itemId: string) => Promise<void>;
  readonly transcript: TranscriptStore;
  readonly refreshQueue: (sessionId?: string) => Promise<TuiQueuedMessage[]>;
  readonly projectQueueItem: (item: TuiQueuedMessage) => void;
  readonly restoreFailedQueueItem?: (itemId: string) => void;
  readonly onLlmRetryChanged?: (event: TuiLlmRetryEvent | undefined) => void;
  readonly onRetryAvailabilityChanged?: (sessionId: string, retryable: boolean) => void;
  readonly goalFlow?: Pick<TuiGoalFlow, 'project' | 'refresh'>;
  readonly updateFollowUpPanel: () => void;
  readonly onChanged: () => void;
  readonly append: AppendLocalCell;
  readonly isStopped: () => boolean;
  readonly queueEnabled: boolean;
  readonly observability?: TuiObservability;
  readonly incidentReporter?: TuiIncidentSink;
  readonly terminalReconciliationTimeoutMs?: number;
  readonly notify?: (kind: TuiTerminalNotificationKind, key: string) => void;
}

export class TuiRuntimeEventFlow {
  private abortController: AbortController | undefined;
  private terminalErrorSequence = 0;
  private task: Promise<void> | undefined;
  private usageCommitTask: Promise<void> | undefined;
  private liveTurn:
    | {
        readonly sessionId: string;
        readonly turnId: string;
        readonly controller: AbortController;
        readonly afterMsgId?: string;
        readonly startedAtMs?: number;
        readonly task: Promise<void>;
      }
    | undefined;
  private readonly llmRetryCalls = new Map<string, TuiLlmRetryEvent>();

  constructor(private readonly options: TuiRuntimeEventFlowOptions) {}

  private captureRuntimeBridgeFailure(
    error: unknown,
    operation: string,
    context: Readonly<Record<string, string | number | boolean | undefined>> = {},
  ): void {
    captureTuiIncidentBestEffort(this.options.incidentReporter, {
      eventType: 'cli_runtime_bridge_error',
      error,
      component: 'runtime-event-flow',
      operation,
      codeLocation: 'src/tui/controller/runtime/runtime-event-flow.ts#TuiRuntimeEventFlow',
      severity: 'warning',
      impact: 'degraded',
      handled: true,
      context,
    });
  }

  private breadcrumb(
    name: string,
    details?: Readonly<Record<string, string | number | boolean | undefined>>,
  ): void {
    try {
      this.options.incidentReporter?.breadcrumb(name, details);
    } catch {
      // Diagnostics must not affect Runtime event handling.
    }
  }

  start(): void {
    if (this.task || this.options.isStopped()) return;
    this.abortController = new AbortController();
    const busController = this.abortController;
    const task = this.consume(busController);
    this.task = task;
    const usageCommitTask = this.consumeUsageCommits(busController.signal);
    this.usageCommitTask = usageCommitTask;
    void usageCommitTask
      .finally(() => {
        if (this.usageCommitTask === usageCommitTask) this.usageCommitTask = undefined;
      })
      .catch(() => undefined);
    void task
      .finally(() => {
        if (this.task !== task) return;
        this.task = undefined;
        if (this.abortController === busController) this.abortController = undefined;
      })
      .catch(() => undefined);
  }

  stop(): void {
    this.clearLlmRetry();
    this.abortController?.abort();
    this.liveTurn?.controller.abort();
    void this.task?.catch(() => undefined);
    void this.usageCommitTask?.catch(() => undefined);
    void this.liveTurn?.task.catch(() => undefined);
    this.liveTurn = undefined;
  }

  restart(): void {
    if (this.options.isStopped()) return;
    const previousTask = this.task;
    this.abortController?.abort();
    if (this.task === previousTask) this.task = undefined;
    this.abortController = undefined;
    this.usageCommitTask = undefined;
    this.clearLlmRetry();
    void previousTask?.catch(() => undefined);
    this.start();
  }

  detachForegroundObserver(): void {
    this.liveTurn?.controller.abort();
    this.liveTurn = undefined;
    this.clearLlmRetry();
  }

  applyActiveSessionProjection(): void {
    this.clearLlmRetry();
    const view = selectActiveSessionView(this.options.stateStore.snapshot());
    const queue = this.options.queueEnabled
      ? [...(view?.execution.queue.values() ?? [])].flatMap((item) =>
          item.runtimeItem ? [item.runtimeItem] : [],
        )
      : [];
    this.options.runProjection.replaceQueue(queue);
    const activeRun = [...(view?.execution.runs.values() ?? [])].find(
      (run) => run.status === 'running' || run.status === 'blocked',
    );
    this.options.runProjection.reconcileRuntimeTurn(activeRun?.turnId ?? activeRun?.runId);
    this.options.updateFollowUpPanel();
    this.options.interactionFlow.replaceFromActiveSession();
    this.options.onChanged();
  }

  private async consume(busController: AbortController): Promise<void> {
    let reconnectAttempt = 0;
    let disconnectedAtMs: number | undefined;
    let reconnectErrorKind: string | undefined;
    let recentStreamFailureCount = 0;
    let lastStreamFailureAtMs: number | undefined;
    const observability = this.options.observability ?? noopTuiObservability;
    const reconcileConnection = async () => {
      await this.options.delegationFlow.refresh();
      if (this.options.isStopped() || busController.signal.aborted) return;
      this.options.stateStore.dispatch({ type: 'connection/subscribed' });
      const effects = this.options.stateStore.dispatch({ type: 'connection/reconnected' });
      await this.options.effectRunner.run(effects);
      if (this.options.isStopped() || busController.signal.aborted) return;
      this.applyActiveSessionProjection();
      await this.reconcileCurrentSessionFromRuntime();
      this.options.controller.refreshStatusMetricsNow();
      await this.options.goalFlow?.refresh(this.options.controller.snapshot().session?.sessionId);
      if (this.options.isStopped() || busController.signal.aborted) return;
      if (reconnectAttempt > 0) {
        this.breadcrumb('cli.runtime.events.reconnected', { attempt: reconnectAttempt });
        observability.recordEventStream({
          state: 'reconnected',
          attempt: reconnectAttempt,
          downtimeMs: Math.max(0, Date.now() - (disconnectedAtMs ?? Date.now())),
        });
        reconnectAttempt = 0;
        disconnectedAtMs = undefined;
        reconnectErrorKind = undefined;
      } else {
        this.breadcrumb('cli.runtime.events.connected');
        observability.recordEventStream({ state: 'connected', attempt: 0 });
      }
    };
    const consumeEvent = async (event: TuiRuntimeEvent) => {
      if (this.options.isStopped() || busController.signal.aborted) return;
      await this.handle(event);
    };
    const recordStreamFailure = (error: unknown, failureKind: string): void => {
      const nowMs = Date.now();
      recentStreamFailureCount =
        lastStreamFailureAtMs !== undefined &&
        nowMs - lastStreamFailureAtMs <= INCIDENT_RECONNECT_WINDOW_MS
          ? recentStreamFailureCount + 1
          : 1;
      lastStreamFailureAtMs = nowMs;
      if (recentStreamFailureCount !== INCIDENT_RECONNECT_FAILURE_THRESHOLD) return;
      this.captureRuntimeBridgeFailure(error, 'watch-events', {
        recentFailures: recentStreamFailureCount,
        failureWindowMs: INCIDENT_RECONNECT_WINDOW_MS,
        errorKind: failureKind,
        sessionId: this.options.controller.snapshot().session?.sessionId,
      });
    };
    while (!this.options.isStopped() && !busController.signal.aborted) {
      try {
        await consumeReconciledEventStream({
          stream: this.options.runtime.watchEvents(busController.signal),
          reconcile: reconcileConnection,
          onEvent: consumeEvent,
        });
        if (this.options.isStopped() || busController.signal.aborted) return;
        reconnectAttempt += 1;
        disconnectedAtMs ??= Date.now();
        reconnectErrorKind = 'StreamEnded';
        this.breadcrumb('cli.runtime.events.disconnected', {
          attempt: reconnectAttempt,
          errorKind: reconnectErrorKind,
        });
        recordStreamFailure(
          new Error('Runtime event stream ended before the CLI stopped.'),
          reconnectErrorKind,
        );
        this.options.stateStore.dispatch({
          type: 'connection/disconnected',
          error: 'Runtime event stream ended.',
        });
        this.options.onChanged();
        observability.recordEventStream({
          state: 'disconnected',
          attempt: reconnectAttempt,
          errorKind: reconnectErrorKind,
        });
      } catch (error) {
        if (this.options.isStopped() || busController.signal.aborted) return;
        reconnectAttempt += 1;
        disconnectedAtMs ??= Date.now();
        reconnectErrorKind = errorKind(error);
        this.breadcrumb('cli.runtime.events.disconnected', {
          attempt: reconnectAttempt,
          errorKind: reconnectErrorKind,
        });
        recordStreamFailure(error, reconnectErrorKind);
        this.options.stateStore.dispatch({
          type: 'connection/disconnected',
          error: formatTuiActionFailure(error, {
            summary: 'Connection lost.',
            nextStep: 'Reconnecting…',
          }),
        });
        this.options.onChanged();
        observability.recordEventStream({
          state: 'disconnected',
          attempt: reconnectAttempt,
          errorKind: reconnectErrorKind,
        });
      }
      const retryDelayMs = eventBusReconnectDelay(reconnectAttempt);
      observability.recordEventStream({
        state: 'retry-scheduled',
        attempt: reconnectAttempt,
        retryDelayMs,
        errorKind: reconnectErrorKind,
      });
      await delayWithAbort(retryDelayMs, busController.signal);
    }
  }

  private async consumeUsageCommits(signal: AbortSignal): Promise<void> {
    const watchSessionUsageCommits = this.options.runtime.watchSessionUsageCommits;
    if (!watchSessionUsageCommits) return;
    for await (const sessionId of watchSessionUsageCommits.call(this.options.runtime, signal)) {
      if (this.options.isStopped() || signal.aborted) return;
      if (this.options.controller.snapshot().session?.sessionId !== sessionId) continue;
      this.options.controller.refreshSessionUsageNow(sessionId);
    }
  }

  private async handle(event: TuiRuntimeEvent): Promise<void> {
    await this.options.delegationFlow.handleRuntimeEvent(event);
    if (isSessionCatalogEvent(event) || event.type === 'rotation.completed') {
      await this.options.sessionFlow.reconcileRuntimeEvent(event);
      this.options.onChanged();
      return;
    }
    const currentSessionId = this.options.controller.snapshot().session?.sessionId;
    const matchesCurrentSession = Boolean(currentSessionId) && event.sessionId === currentSessionId;
    let liveTurnDurationMs: number | undefined;
    const sessionScopedResult = this.handleSessionScopedEvent(event, matchesCurrentSession);
    if (sessionScopedResult === true) return;
    if (sessionScopedResult && (await sessionScopedResult)) return;
    const activeRunRefresh = this.refreshActiveRunForEvent(
      event,
      currentSessionId,
      matchesCurrentSession,
    );
    if (activeRunRefresh) await activeRunRefresh;
    if (this.options.controller.snapshot().session?.sessionId !== currentSessionId) {
      this.options.stateCoordinator.project(event);
      return;
    }
    if (
      matchesCurrentSession &&
      currentSessionId &&
      event.type === 'session.start' &&
      event.turnId &&
      (this.options.controller.snapshot().activeTurnId !== event.turnId ||
        event.runSource === 'queued-drain')
    ) {
      this.startLiveTurn(
        currentSessionId,
        event.turnId,
        event.timestampMs,
        this.options.controller.latestDurableMessageId(),
      );
    }
    if (
      matchesCurrentSession &&
      (event.type === 'session.finish' ||
        event.type === 'session.error' ||
        event.type === 'session.abort')
    ) {
      liveTurnDurationMs = await this.settleLiveTurn(event);
    }
    const interactionHandled = currentSessionId
      ? await this.options.interactionFlow.handleRuntimeEvent(event, currentSessionId)
      : false;
    if (!interactionHandled || !isInteractionProjectionEvent(event)) {
      this.options.stateCoordinator.project(event);
    }
    if (this.options.controller.snapshot().session?.sessionId !== currentSessionId) return;
    if (!currentSessionId || !matchesCurrentSession) return;
    if (interactionHandled && isInteractionProjectionEvent(event)) {
      await this.options.activeRunFlow.refresh(true);
      return;
    }
    if (event.type === 'session.queue.updated') {
      if (!this.options.queueEnabled) return;
      await this.handleQueueUpdated(event, currentSessionId);
      return;
    }
    if (event.type === 'session.start' && event.runSource === 'queued-drain') {
      this.handleQueuedDrainStarted(event);
      return;
    }
    if (
      event.type === 'session.finish' ||
      event.type === 'session.error' ||
      event.type === 'session.abort'
    ) {
      const terminalSettled = await this.handleRuntimeTurnFinished(
        event,
        currentSessionId,
        liveTurnDurationMs,
        interactionHandled,
      );
      if (terminalSettled) this.options.delegationFlow.handleSettledRuntimeEvent(event);
      await this.notifyTerminalEvent(event, currentSessionId);
    }
  }

  private handleSessionScopedEvent(
    event: TuiRuntimeEvent,
    matchesCurrentSession: boolean,
  ): boolean | Promise<boolean> {
    if (
      event.sessionId &&
      (event.type === 'session.finish' ||
        event.type === 'session.error' ||
        event.type === 'session.abort')
    ) {
      this.options.onRetryAvailabilityChanged?.(
        event.sessionId,
        event.type === 'session.error'
          ? resolveTuiRuntimeFailure(event.error, event.errorCode, {
              errorSource: event.errorSource,
              errorDetail: event.errorDetail,
              errorProviderId: event.errorProviderId,
            }).retryable
          : false,
      );
    }
    if (event.type === 'thread_goal.updated' || event.type === 'thread_goal.cleared') {
      if (matchesCurrentSession) this.options.goalFlow?.project(event);
      return true;
    }
    if (
      !matchesCurrentSession &&
      this.options.queueEnabled &&
      event.type === 'session.queue.updated'
    ) {
      return this.reconcileQueueOwnership(event, false).then(() => false);
    }
    if (matchesCurrentSession && event.type === 'session.llm_retry') {
      this.applyLlmRetry(event);
      this.options.onChanged();
      return true;
    }
    if (matchesCurrentSession && event.type === 'content.retry.exceeded') {
      this.options.append(
        event.variant === 'auth'
          ? 'Content review authentication expired. Run /login, then retry.'
          : event.variant === 'network'
            ? 'Content review did not return a usable result, so this response stopped. Unreviewed output was withheld. Retry; if this persists, use /feedback to report the review failure.'
            : 'Content review withdrew this response. Rephrase your request, then retry.',
        'warning',
      );
      this.options.onChanged();
      return true;
    }
    if (matchesCurrentSession && event.type === 'message.rewind') {
      return this.options.controller.reconcileOwnerHistory(true).then(() => {
        this.options.onChanged();
        return true;
      });
    }
    if (matchesCurrentSession && isCompactionEvent(event)) {
      return this.options.controller.reconcileOwnerHistory(false).then(() => {
        this.options.onChanged();
        return true;
      });
    }
    return false;
  }

  private refreshActiveRunForEvent(
    event: TuiRuntimeEvent,
    currentSessionId: string | undefined,
    matchesCurrentSession: boolean,
  ): Promise<void> | undefined {
    if (
      !matchesCurrentSession ||
      (event.type !== 'session.start' &&
        event.type !== 'session.finish' &&
        event.type !== 'session.error' &&
        event.type !== 'session.abort' &&
        event.type !== 'session.active_run.action')
    ) {
      return;
    }
    if (
      event.type === 'session.finish' ||
      event.type === 'session.error' ||
      event.type === 'session.abort'
    ) {
      this.clearLlmRetry();
    }
    return this.options.activeRunFlow.refresh(true).then(async () => {
      if (
        event.type === 'session.start' &&
        event.runSource === 'queued-drain' &&
        currentSessionId
      ) {
        await this.options.controller
          .refreshSessionMetadata(currentSessionId)
          .catch(() => undefined);
      }
    });
  }

  adoptRuntimeTurn(sessionId: string, turnId: string, timestampMs: number): void {
    if (
      this.options.isStopped() ||
      this.options.controller.snapshot().session?.sessionId !== sessionId ||
      this.options.controller.snapshot().activeTurnId === turnId
    ) {
      return;
    }
    this.startLiveTurn(
      sessionId,
      turnId,
      timestampMs,
      this.options.controller.latestDurableMessageId(),
    );
  }

  private startLiveTurn(
    sessionId: string,
    turnId: string,
    timestampMs: number | undefined,
    afterMsgId?: string,
  ): void {
    const previousLiveTurn = this.liveTurn;
    const isSameTurn =
      previousLiveTurn?.sessionId === sessionId && previousLiveTurn.turnId === turnId;
    if (isSameTurn) return;
    previousLiveTurn?.controller.abort();
    void previousLiveTurn?.task.catch(() => undefined);

    const controller = new AbortController();
    if (!isSameTurn) {
      this.options.controller.beginRuntimeTurn(turnId, timestampMs ?? Date.now());
      this.options.runProjection.markRecoveredTurn(turnId);
    }
    const liveTurn = {
      sessionId,
      turnId,
      controller,
      afterMsgId,
      startedAtMs: timestampMs,
      task: Promise.resolve(),
    };
    // The stream can end before the lifecycle terminal event supplies the end time.
    // Retain the turn until that event settles its projection.
    const task = this.consumeLiveTurn(liveTurn).catch(() => undefined);
    this.liveTurn = { ...liveTurn, task };
    this.options.onChanged();
  }

  private async consumeLiveTurn(liveTurn: {
    readonly sessionId: string;
    readonly turnId: string;
    readonly controller: AbortController;
    readonly afterMsgId?: string;
    readonly startedAtMs?: number;
  }): Promise<void> {
    let afterMsgId = liveTurn.afterMsgId;
    let afterCursor: string | undefined;
    let reconnectAttempt = 0;
    while (!liveTurn.controller.signal.aborted) {
      let overflowed = false;
      let receivedEvent = false;
      try {
        const resumeOptions = afterCursor
          ? { afterCursor }
          : afterMsgId
            ? { afterMsgId }
            : undefined;
        const stream = resumeOptions
          ? this.options.runtime.watchSessionTurn(
              liveTurn.sessionId,
              liveTurn.turnId,
              liveTurn.controller.signal,
              resumeOptions,
            )
          : this.options.runtime.watchSessionTurn(
              liveTurn.sessionId,
              liveTurn.turnId,
              liveTurn.controller.signal,
            );
        for await (const event of stream) {
          if (
            liveTurn.controller.signal.aborted ||
            this.options.controller.snapshot().session?.sessionId !== liveTurn.sessionId
          ) {
            return;
          }
          if (event.type === 'resync-required') {
            overflowed = true;
            break;
          }
          receivedEvent = true;
          if (event.cursor) afterCursor = event.cursor;
          const failure = this.options.controller.applyRuntimeTurnEvent(liveTurn.turnId, event);
          if (failure) this.options.append(failure, 'error');
          if (isSessionTurnTerminal(event)) return;
        }
      } catch {
        if (liveTurn.controller.signal.aborted) return;
      }

      if (overflowed) {
        try {
          await this.options.controller.reconcileOwnerHistory(false);
        } catch (error) {
          this.options.append(
            formatTuiActionFailure(error, {
              summary: "Couldn't recover the live response view.",
              nextStep: 'Reopen the session to load its saved messages.',
            }),
            'warning',
          );
          return;
        }
        if (this.options.controller.snapshot().session?.sessionId !== liveTurn.sessionId) return;
        this.options.onChanged();
        afterCursor = undefined;
        afterMsgId = undefined;
        reconnectAttempt = 0;
        continue;
      }
      if (liveTurn.controller.signal.aborted) return;
      afterMsgId = this.options.controller.latestDurableMessageId() ?? afterMsgId;
      reconnectAttempt = receivedEvent ? 0 : reconnectAttempt + 1;
      await delayWithAbort(
        eventBusReconnectDelay(reconnectAttempt + 1),
        liveTurn.controller.signal,
      );
    }
  }

  private async settleLiveTurn(event: TuiSessionLifecycleEvent): Promise<number | undefined> {
    const liveTurn = this.liveTurn;
    if (!liveTurn || !event.turnId || liveTurn.turnId !== event.turnId) return undefined;
    liveTurn.controller.abort();
    await liveTurn.task;
    if (this.options.controller.snapshot().session?.sessionId !== liveTurn.sessionId) {
      return undefined;
    }
    if (
      this.liveTurn &&
      (this.liveTurn.sessionId !== liveTurn.sessionId || this.liveTurn.turnId !== liveTurn.turnId)
    ) {
      return undefined;
    }
    // An interaction can keep the user-visible turn open after Runtime stops.
    const durationMs =
      liveTurn.startedAtMs === undefined
        ? undefined
        : Math.max(0, event.timestampMs - liveTurn.startedAtMs);
    const settledDurationMs = this.options.interactionFlow.continuesTurn(
      liveTurn.sessionId,
      liveTurn.turnId,
    )
      ? undefined
      : durationMs;
    this.options.controller.runtimeTurnSettlement.settleProjection(
      liveTurn.turnId,
      terminalTurnStatus(event),
      settledDurationMs,
    );
    this.liveTurn = undefined;
    return settledDurationMs;
  }

  private async handleQueueUpdated(event: TuiQueueUpdatedEvent, sessionId: string): Promise<void> {
    const { itemId, status, queuedCount } = event;
    // Runtime acknowledges an accepted Queue item after assigning its Turn but
    // may publish `session.start` slightly later. Preserve busy ownership across
    // that seam so automation cannot observe the previous terminal in between.
    if (status === 'accepted') this.options.runProjection.markQueueHandoffPending();
    if (queuedCount !== undefined) this.options.runProjection.setQueuedCount(queuedCount);
    if (await this.reconcileQueueOwnership(event, true)) {
      this.options.onChanged();
      return;
    }
    if (itemId && status) {
      const existing = this.options.transcript.get(`queue:${itemId}`);
      const cached = this.options.runProjection.findQueueItem(itemId);
      if (cached || existing) {
        const item: TuiQueuedMessage = {
          ...(cached ?? {
            itemId,
            sessionId,
            ...(existing?.content ? { content: existing.content } : {}),
          }),
          status,
          ...queueFailureReason(event),
        };
        this.options.runProjection.updateQueueItem(item);
        this.options.projectQueueItem(item);
      } else if (status === 'queued') {
        await this.options.refreshQueue(sessionId);
      }
    } else {
      await this.options.refreshQueue(sessionId);
    }
    this.options.onChanged();
  }

  private async reconcileQueueOwnership(
    event: TuiQueueUpdatedEvent,
    restoreToComposer: boolean,
  ): Promise<boolean> {
    const { itemId, status } = event;
    if (!itemId || !status) return false;
    if (status === 'admission-rejected') {
      const failedReason =
        queueFailureReason(event).failedReason ?? 'Message was not added to the Queue. Retry.';
      if (restoreToComposer) this.options.restoreFailedQueueItem?.(itemId);
      await this.options.releaseQueueItem(itemId);
      if (restoreToComposer) this.options.append(failedReason, 'error');
      return true;
    }
    if (status !== 'queued' && status !== 'running') {
      await this.options.releaseQueueItem(itemId);
    }
    return false;
  }

  private applyLlmRetry(event: TuiLlmRetryEvent): void {
    if (event.status === 'waiting') {
      this.llmRetryCalls.delete(event.callId);
      this.llmRetryCalls.set(event.callId, event);
    } else this.llmRetryCalls.delete(event.callId);
    this.options.onLlmRetryChanged?.([...this.llmRetryCalls.values()].at(-1));
  }

  private clearLlmRetry(): void {
    if (this.llmRetryCalls.size === 0) return;
    this.llmRetryCalls.clear();
    this.options.onLlmRetryChanged?.(undefined);
  }

  private handleQueuedDrainStarted(event: TuiSessionLifecycleEvent): void {
    this.options.runProjection.markQueueTurnStarted(event.turnId);
    for (const itemId of event.queueItemIds) {
      const cached = this.options.runProjection.findQueueItem(itemId);
      if (!cached) continue;
      const running: TuiQueuedMessage = { ...cached, status: 'running' };
      this.options.runProjection.updateQueueItem(running);
      this.options.projectQueueItem(running);
    }
    this.options.onChanged();
  }

  private async handleRuntimeTurnFinished(
    event: TuiSessionLifecycleEvent,
    sessionId: string,
    liveTurnDurationMs?: number,
    interactionHandled = false,
  ): Promise<boolean> {
    if (this.options.controller.snapshot().activeTurnId) return false;

    const activeRun = this.options.activeRunFlow.currentSnapshot();
    const activeRuntimeTurnId =
      activeRun?.sessionId === sessionId &&
      (activeRun.state === 'running' || activeRun.state === 'decision-blocked')
        ? activeRun.turnId
        : undefined;
    if (activeRuntimeTurnId && event.turnId && activeRuntimeTurnId !== event.turnId) {
      this.options.runProjection.reconcileRuntimeTurn(activeRuntimeTurnId);
      this.options.onChanged();
      return false;
    }

    const projectedTurnId = this.options.runProjection.snapshot().latestRuntimeTurnId;
    const eventMatchesProjection =
      !projectedTurnId ||
      !event.turnId ||
      projectedTurnId === event.turnId ||
      projectedTurnId.startsWith('session:');
    if (!eventMatchesProjection) return false;

    // Late or background terminal events cannot settle the foreground turn.
    const ownsTerminal = Boolean(
      event.turnId && (projectedTurnId === event.turnId || projectedTurnId?.startsWith('session:')),
    );
    const runtimeSettlement = this.options.controller.runtimeTurnSettlement;
    const automationResultEnabled = runtimeSettlement.enabled();
    const continuationPending =
      event.type === 'session.finish' &&
      event.turnId !== undefined &&
      this.options.interactionFlow.continuesTurn(sessionId, event.turnId) &&
      !interactionHandled;
    const deferredSettlement =
      ownsTerminal && event.turnId && automationResultEnabled
        ? runtimeSettlement.prepare(sessionId, event.turnId, terminalTurnStatus(event))
        : undefined;
    if (ownsTerminal && event.turnId && !automationResultEnabled) {
      await runtimeSettlement.settle(
        sessionId,
        event.turnId,
        terminalTurnStatus(event),
        liveTurnDurationMs,
      );
    }

    this.options.runProjection.reconcileRuntimeTurn();
    const terminalReconciliationTimeoutMs =
      this.options.terminalReconciliationTimeoutMs ?? TERMINAL_RECONCILIATION_TIMEOUT_MS;
    const requiresDurableAutomationAnswer =
      deferredSettlement?.status === 'succeeded' && !continuationPending;
    let automationHistoryError: ExecResultError | undefined;
    if (requiresDurableAutomationAnswer) {
      const historyOutcome = await settleWithin(
        this.options.controller.reconcileOwnerHistory(false),
        terminalReconciliationTimeoutMs,
      );
      automationHistoryError = automationHistoryReconciliationError(historyOutcome);
      if (automationHistoryError) {
        this.options.append(
          `${automationHistoryError.message} Reopen the Session to retry synchronization.`,
          'error',
        );
      }
    }
    const reconciliation = this.refreshRuntimeSessionProjection(sessionId, {
      includeDurableHistory: !requiresDurableAutomationAnswer,
    });
    const outcome = await settleWithin(reconciliation, terminalReconciliationTimeoutMs);
    if (outcome.status === 'timeout') {
      if (!deferredSettlement) this.appendTerminalError(event);
      this.options.append(
        'Runtime state refresh timed out after the response stopped. Reopen the Session to retry synchronization.',
        'error',
      );
      if (!deferredSettlement) return false;
    } else if (outcome.status === 'failed') {
      if (!deferredSettlement) this.appendTerminalError(event);
      this.options.append(
        formatTuiActionFailure(outcome.error, {
          summary: "Couldn't refresh the saved response state.",
          nextStep: 'Reopen the session to retry.',
          preservation: 'Your prompt is preserved.',
        }),
        'error',
      );
      if (!deferredSettlement) return false;
    }
    if (deferredSettlement && !continuationPending) {
      await runtimeSettlement.publish(
        automationHistoryError ? { ...deferredSettlement, status: 'failed' } : deferredSettlement,
        liveTurnDurationMs,
        automationHistoryError ?? automationTerminalError(event),
      );
      return true;
    }
    if (!deferredSettlement || continuationPending) this.appendTerminalError(event);
    return ownsTerminal && !automationResultEnabled;
  }

  /**
   * Records a terminal `session.error` as a transcript cell that carries the failed turn id.
   *
   * The Chat snapshot's `status: 'error'` is transient because durable history reconciliation
   * resets it to `idle`. This ephemeral cell preserves the human-visible failed frame across that
   * reconciliation. The `[V]` protocol does not consume this cell; it uses the canonical
   * `lastSettledTurn` published by `TuiRuntimeTurnSettlement` after result delivery.
   */
  private appendTerminalError(event: TuiSessionLifecycleEvent): void {
    if (event.type !== 'session.error') return;
    const content = formatTuiRuntimeFailure(event.error, event.errorCode, {
      errorSource: event.errorSource,
      errorDetail: event.errorDetail,
      errorProviderId: event.errorProviderId,
    });
    if (!event.turnId) {
      this.options.append(content, 'error');
      return;
    }
    if (this.options.isStopped()) return;
    const now = Date.now();
    this.terminalErrorSequence += 1;
    this.options.transcript.upsert({
      id: `terminal-error:${event.turnId}:${String(this.terminalErrorSequence)}`,
      kind: 'error',
      status: 'failed',
      content,
      turnId: event.turnId,
      ephemeral: true,
      createdAtMs: now,
      updatedAtMs: now,
    });
    this.options.onChanged();
  }

  private async notifyTerminalEvent(
    event: TuiSessionLifecycleEvent,
    sessionId: string,
  ): Promise<void> {
    if (
      !this.options.notify ||
      !event.turnId ||
      this.options.isStopped() ||
      this.options.controller.snapshot().session?.sessionId !== sessionId ||
      (event.type !== 'session.finish' && event.type !== 'session.error')
    )
      return;
    // A failed Turn still needs attention when another message remains queued.
    if (event.type === 'session.error') {
      this.options.notify('turn-failed', `turn-failed:${sessionId}:${event.turnId}`);
      return;
    }
    const [activeRun, queue] = await Promise.allSettled([
      this.options.runtime.getActiveRun(sessionId),
      this.options.queueEnabled
        ? this.options.runtime.listQueuedMessages(sessionId)
        : Promise.resolve([]),
    ]);
    if (
      activeRun.status === 'rejected' ||
      queue.status === 'rejected' ||
      this.options.isStopped() ||
      this.options.controller.snapshot().session?.sessionId !== sessionId
    ) {
      return;
    }
    const hasActiveRun = Boolean(
      this.options.controller.snapshot().activeTurnId ||
      (activeRun.value.sessionId === sessionId &&
        (activeRun.value.state === 'running' || activeRun.value.state === 'decision-blocked')),
    );
    const queuedCount = queue.value.filter(
      (item) => item.status === 'queued' || item.status === 'running',
    ).length;
    if (!shouldNotifyMcodeTurnComplete({ queuedCount, hasActiveRun })) return;
    this.options.notify('turn-complete', `turn-complete:${sessionId}:${event.turnId}`);
  }

  private async reconcileCurrentSessionFromRuntime(): Promise<boolean> {
    const initial = this.options.controller.snapshot();
    const sessionId = initial.session?.sessionId;
    if (!sessionId) return false;

    await this.options.activeRunFlow.refresh(true);
    const current = this.options.controller.snapshot();
    if (current.session?.sessionId !== sessionId || current.activeTurnId) return false;

    const activeRun = this.options.activeRunFlow.currentSnapshot();
    let activeTurnId: string | undefined;
    if (activeRun?.sessionId === sessionId) {
      const turnId =
        activeRun.state === 'running' || activeRun.state === 'decision-blocked'
          ? (activeRun.turnId ?? `session:${sessionId}`)
          : undefined;
      this.options.runProjection.reconcileRuntimeTurn(turnId);
      activeTurnId = turnId?.startsWith('session:') ? undefined : turnId;
    }
    const reconciled = await this.refreshRuntimeSessionProjection(sessionId);
    if (
      activeTurnId &&
      this.options.controller.snapshot().session?.sessionId === sessionId &&
      !this.options.controller.snapshot().activeTurnId
    ) {
      this.startLiveTurn(
        sessionId,
        activeTurnId,
        undefined,
        this.options.controller.latestDurableMessageId(),
      );
    }
    return reconciled;
  }

  private async refreshRuntimeSessionProjection(
    sessionId: string,
    options: { includeDurableHistory?: boolean } = {},
  ): Promise<boolean> {
    const incompleteParts: string[] = [];
    const refreshFailures: Array<{ readonly part: string; readonly error: unknown }> = [];
    let reconciled = false;

    if (
      options.includeDurableHistory &&
      this.options.controller.snapshot().session?.sessionId === sessionId
    ) {
      try {
        const refreshed = await this.options.controller.reconcileOwnerHistory(false);
        reconciled ||= refreshed;
      } catch (error) {
        refreshFailures.push({ part: 'history', error });
        incompleteParts.push(`History: ${tuiErrorDiagnostic(error)}`);
      }
    }

    if (this.options.queueEnabled) {
      try {
        await this.options.refreshQueue(sessionId);
        reconciled = true;
      } catch (error) {
        refreshFailures.push({ part: 'queue', error });
        incompleteParts.push(`Queue: ${tuiErrorDiagnostic(error)}`);
      }
    }

    try {
      await this.options.controller.refreshSessionMetadata(sessionId);
      reconciled = true;
    } catch (error) {
      refreshFailures.push({ part: 'session-metadata', error });
      incompleteParts.push(`Session metadata: ${tuiErrorDiagnostic(error)}`);
    }

    if (incompleteParts.length > 0) {
      const failedParts = refreshFailures.map(({ part }) => part).join(',');
      this.captureRuntimeBridgeFailure(
        new AggregateError(
          refreshFailures.map(({ error }) => error),
          `Runtime session refresh failed for ${failedParts}.`,
        ),
        'refresh-session-projection',
        {
          sessionId,
          failedPartCount: refreshFailures.length,
          failedParts,
        },
      );
      this.options.append(
        `Couldn't fully refresh this session (${incompleteParts.join('; ')}). Reopen the session to retry.`,
        'warning',
      );
    }
    this.options.onChanged();
    return reconciled;
  }
}

function eventBusReconnectDelay(attempt: number): number {
  return Math.min(
    EVENT_BUS_RECONNECT_BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1),
    EVENT_BUS_RECONNECT_MAX_DELAY_MS,
  );
}

function queueFailureReason(event: TuiQueueUpdatedEvent): Pick<TuiQueuedMessage, 'failedReason'> {
  const failedReason =
    event.status === 'admission-rejected'
      ? formatQueueFailure(
          'Message was not added to the Queue',
          event.failedReason ?? event.admissionReason ?? event.reason,
          'Wait for the current response or retry.',
        )
      : event.status === 'failed'
        ? formatQueueFailure(
            'Message failed before it could start',
            event.failedReason ?? event.reason,
            'Retry from the Queue.',
          )
        : undefined;
  return failedReason ? { failedReason } : {};
}

function formatQueueFailure(summary: string, reason: string | undefined, nextStep: string): string {
  return reason
    ? `${summary}: ${tuiErrorDiagnostic(reason)}. ${nextStep}`
    : `${summary}. ${nextStep}`;
}

function terminalTurnStatus(event: TuiSessionLifecycleEvent): 'succeeded' | 'failed' | 'cancelled' {
  if (event.type === 'session.finish') return 'succeeded';
  return event.type === 'session.abort' ? 'cancelled' : 'failed';
}

function automationTerminalError(event: TuiSessionLifecycleEvent): ExecResultError | undefined {
  if (event.type !== 'session.error') return undefined;
  const failure = resolveTuiRuntimeFailure(event.error, event.errorCode, {
    errorSource: event.errorSource,
    errorDetail: event.errorDetail,
    errorProviderId: event.errorProviderId,
  });
  return {
    category: 'runtime',
    ...(event.errorCode !== undefined ? { code: String(event.errorCode) } : {}),
    message: failure.content,
    retryable: failure.retryable,
  };
}

function isSessionTurnTerminal(event: TuiStreamEvent): boolean {
  if (event.type === 'done' || event.type === 'error') return true;
  return (
    event.type === 'session-status' &&
    (event.status === 'finished' ||
      event.status === 'error' ||
      event.status === 'aborted' ||
      event.status === 'interrupted')
  );
}

function isInteractionProjectionEvent(event: TuiRuntimeEvent): boolean {
  return (
    event.type === 'permission.ask' ||
    event.type === 'permission.resolved' ||
    event.type === 'questionnaire.ask' ||
    event.type === 'questionnaire.dismiss' ||
    event.type === 'questionnaire.superseded'
  );
}

function isSessionCatalogEvent(event: TuiRuntimeEvent): event is TuiSessionCatalogEvent {
  return (
    event.type === 'session.created' ||
    event.type === 'session.deleted' ||
    event.type === 'session.title_updated' ||
    event.type === 'session.pinned_updated'
  );
}

function isCompactionEvent(event: TuiRuntimeEvent): boolean {
  return (
    event.type === 'session.compaction.started' ||
    event.type === 'session.compaction.completed' ||
    event.type === 'session.compaction.failed'
  );
}

function errorKind(error: unknown): string {
  if (error instanceof Error && error.name) return error.name;
  return typeof error;
}

type TimedSettlement<T> =
  | { readonly status: 'settled'; readonly value: T }
  | { readonly status: 'failed'; readonly error: unknown }
  | { readonly status: 'timeout' };

function automationHistoryReconciliationError(
  outcome: TimedSettlement<boolean>,
): ExecResultError | undefined {
  if (outcome.status === 'timeout') {
    return {
      category: 'runtime',
      code: 'AUTOMATION_HISTORY_RECONCILIATION_TIMEOUT',
      message: 'Timed out before the final saved response could be confirmed.',
      retryable: true,
    };
  }
  if (outcome.status === 'failed' || !outcome.value) {
    return {
      category: 'runtime',
      code: 'AUTOMATION_HISTORY_RECONCILIATION_FAILED',
      message: 'Could not confirm the final saved response.',
      retryable: true,
    };
  }
  return undefined;
}

async function settleWithin<T>(
  operation: Promise<T>,
  timeoutMs: number,
): Promise<TimedSettlement<T>> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race<TimedSettlement<T>>([
    operation.then(
      (value) => ({ status: 'settled' as const, value }),
      (error: unknown) => ({ status: 'failed' as const, error }),
    ),
    new Promise<TimedSettlement<T>>((resolve) => {
      timeout = setTimeout(() => resolve({ status: 'timeout' }), Math.max(0, timeoutMs));
      timeout.unref?.();
    }),
  ]);
  if (timeout) clearTimeout(timeout);
  return outcome;
}
