import type {
  TuiActiveRunSnapshot,
  TuiDelegationPort,
  TuiRuntimeEvent,
  TuiSession,
  TuiSessionPort,
  TuiSessionTurnPort,
  TuiActiveRunControlPort,
  TuiMessage,
  TuiBackgroundTask,
  TuiBackgroundTaskCapability,
} from '../../runtime/port.js';
import { isActiveTuiDelegatedAgent, isTuiDelegatedSession } from '../../runtime/delegation.js';
import { TuiAgentTeamProjection, type TuiAgentTeamSnapshot } from '../agent-team/model.js';
import { TuiAgentTeamPanel } from '../agent-team/panel.js';
import { TuiBackgroundWorkPanel } from '../background-work/panel.js';
import { TuiTranscriptPanel } from '../features/transcript/panel.js';
import type { TuiFeatureScreenHandle, TuiSurfaceHost } from '../shell/surface-host.js';
import { TranscriptStore } from '../transcript/store.js';
import { TuiTurnProjection } from './projection/turn-projection.js';

const MAX_PARENT_DEPTH = 32;
const CHILD_HISTORY_LIMIT = 200;
const BACKGROUND_TASK_POLL_MS = 1_000;

type AgentTeamRuntime = TuiDelegationPort &
  TuiBackgroundTaskCapability &
  Pick<TuiSessionPort, 'getMessages' | 'getSession'> &
  TuiSessionTurnPort &
  Pick<TuiActiveRunControlPort, 'getActiveRun'>;

interface ChildWatcher {
  readonly sessionId: string;
  readonly turnId: string;
  readonly controller: AbortController;
  retiring: boolean;
  task: Promise<void>;
}

export interface TuiDelegationFlowOptions {
  readonly runtime: AgentTeamRuntime;
  readonly currentSession: () => TuiSession | undefined;
  readonly surfaceHost?: TuiSurfaceHost;
  readonly openSession?: (sessionId: string) => Promise<void>;
  readonly onAgentTeamChanged?: (snapshot: TuiAgentTeamSnapshot) => void;
  readonly onBackgroundTasksChanged?: (tasks: readonly TuiBackgroundTask[]) => void;
  /**
   * `[V]` machine status is shown: list sub-Agent Tasks and their Runtime notification facts so
   * `agentCounts()` and `backgroundTaskCount()` can wait for undelivered reports. Other TUIs
   * never read those counts and skip the notification ledger.
   */
  readonly machineStatus?: boolean;
  readonly onChanged: () => void;
  readonly onError?: (error: unknown) => void;
}

export class TuiDelegationFlow {
  private readonly projection = new TuiAgentTeamProjection();
  private readonly watchers = new Map<string, ChildWatcher>();
  private refreshSequence = 0;
  private stopped = false;
  private rootSessionId: string | undefined;
  private memberIds = new Set<string>();
  private refreshErrorReported = false;
  private teamScreen: TuiFeatureScreenHandle | undefined;
  private tasksScreen: TuiFeatureScreenHandle | undefined;
  private tasksScreenGeneration = 0;
  private agentTranscriptScreen: TuiFeatureScreenHandle | undefined;
  private agentTranscriptLoadingGeneration: number | undefined;
  private watcherRetryTimer: ReturnType<typeof setTimeout> | undefined;
  private watcherRetryAttempt = 0;
  private backgroundTaskPollTimer: ReturnType<typeof setTimeout> | undefined;
  private backgroundTaskPollInFlight = false;
  private backgroundTaskTerminalPollPending = false;
  private backgroundTaskRequestSequence = 0;
  /** Every root Task the Runtime lists, sub-Agent Tasks included. */
  private backgroundTasks: readonly TuiBackgroundTask[] = [];
  private rootRunActive = false;
  /**
   * Request sequence a successful Task list must exceed before a settled root Turn may report
   * zero background Tasks: a command yielded just before settle may postdate the last list.
   */
  private backgroundTaskListBarrier: number | undefined;

  constructor(private readonly options: TuiDelegationFlowOptions) {}

  stop(): void {
    this.stopped = true;
    this.resetProjection();
  }

  reset(): void {
    this.refreshSequence += 1;
    this.resetProjection();
  }

  /**
   * Machine-status counts for the currently selected root Session. A member is active while it
   * is queued, running or waiting, and its sub-Agent Task stays active until the Runtime reports
   * its root notification settled, so a finished child never reads as done before a parent Turn
   * has taken the report. From then on the parent Turn's own state carries the wait.
   */
  agentCounts(): { readonly active: number; readonly total: number } {
    const current = this.options.currentSession();
    const snapshot = this.projection.snapshot();
    if (!current || snapshot.rootSessionId !== current.sessionId) return { active: 0, total: 0 };
    const activeKeys = new Set(
      snapshot.members
        .filter(
          (member) =>
            member.status === 'queued' ||
            member.status === 'running' ||
            member.status === 'waiting',
        )
        .map((member) => member.sessionId),
    );
    for (const task of this.backgroundTasks) {
      if (task.kind !== 'subagent') continue;
      // A child not created yet has no member to pair with; the spawning root Turn covers it.
      if (isActiveTaskStatus(task.status) ? task.childSessionId : owesNotification(task)) {
        activeKeys.add(task.childSessionId ?? `task:${task.taskId}`);
      }
    }
    return {
      active: activeKeys.size,
      total: snapshot.summary.total,
    };
  }

  /**
   * Machine-status count of the root's background Tasks (bash/workflow/custom) that are still
   * queued, running or stopping, or terminal with a root notification the Runtime has not
   * settled. Bash still owned by its foreground tool call is not counted, and sub-Agent Tasks
   * stay in `agentCounts()`.
   */
  backgroundTaskCount(): number {
    const current = this.options.currentSession();
    if (!current || this.rootSessionId !== current.sessionId) return 0;
    const unsettled = this.rootBackgroundTasks().filter(
      (task) => !task.foreground && (isActiveTaskStatus(task.status) || owesNotification(task)),
    ).length;
    return this.backgroundTaskListBarrier === undefined ? unsettled : Math.max(unsettled, 1);
  }

  snapshot(): TuiAgentTeamSnapshot {
    return this.projection.snapshot();
  }

  /** Current canonical turn for an interaction owner in the selected Session tree. */
  ownerTurnId(sessionId: string, rootTurnId?: string): string | undefined {
    const current = this.options.currentSession();
    const snapshot = this.projection.snapshot();
    if (!current || snapshot.rootSessionId !== current.sessionId) return undefined;
    if (sessionId === current.sessionId) return rootTurnId;
    return snapshot.members.find((member) => member.sessionId === sessionId)?.turnId;
  }

  permissionResolvers(rootTurnId: () => string | undefined) {
    return {
      permissionSessionScope: (sessionId: string) => this.permissionSessionScope(sessionId),
      permissionOwnerTurnId: (sessionId: string) => this.ownerTurnId(sessionId, rootTurnId()),
    };
  }

  async refresh(): Promise<void> {
    const current = this.options.currentSession();
    if (this.stopped || !current) return;
    const sequence = ++this.refreshSequence;
    let rootSessionId: string;
    let snapshot;
    try {
      rootSessionId = await this.resolveRootSessionId(current);
      snapshot = await this.options.runtime.getDelegationSnapshot(rootSessionId);
      this.refreshErrorReported = false;
    } catch (error) {
      this.reportRefreshError(error);
      return;
    }
    if (!this.isCurrent(sequence, current.sessionId)) return;

    const activeRuns = new Map<string, TuiActiveRunSnapshot>();
    const durableSuccessfulTurns = new Map<string, string>();
    let activeRunInspectionFailed = false;
    await Promise.all(
      snapshot.members.filter(isActiveTuiDelegatedAgent).map(async (member) => {
        let activeRun: TuiActiveRunSnapshot;
        let activeRunInspected = true;
        try {
          activeRun = await this.options.runtime.getActiveRun(member.sessionId);
        } catch {
          activeRunInspectionFailed = true;
          activeRunInspected = false;
          activeRun = {
            schemaVersion: 1,
            sessionId: member.sessionId,
            state: member.status === 'running' ? 'running' : 'idle',
            actions: { steer: false },
          };
        }
        activeRuns.set(member.sessionId, activeRun);
        if (!activeRunInspected || activeRun.state !== 'idle' || member.status !== 'queued') return;
        try {
          // Runtime V2 persists the final assistant message before a successful terminal
          // returns the Session to idle. Together those existing facts recover cold TUI state
          // without treating a newly queued idle child as completed.
          const terminalTurnId = latestSuccessfulTurnId(
            await this.options.runtime.getMessages(member.sessionId, CHILD_HISTORY_LIMIT),
          );
          if (terminalTurnId) durableSuccessfulTurns.set(member.sessionId, terminalTurnId);
        } catch {
          activeRunInspectionFailed = true;
        }
      }),
    );
    if (!this.isCurrent(sequence, current.sessionId)) return;

    if (this.rootSessionId !== rootSessionId) this.backgroundTasks = [];
    this.rootSessionId = rootSessionId;
    this.memberIds = new Set(snapshot.members.map((member) => member.sessionId));
    const nowMs = Date.now();
    this.projection.replace(rootSessionId, snapshot.members, activeRuns, nowMs);
    for (const [sessionId, turnId] of durableSuccessfulTurns) {
      this.projection.markDone(sessionId, turnId, nowMs);
    }
    this.publishProjection();
    this.reconcileWatchers(activeRuns, current.sessionId);
    if (activeRunInspectionFailed) this.scheduleTeamRefreshRetry(current.sessionId);

    const [rootRun, backgroundTasksChanged] = await Promise.all([
      this.options.runtime.getActiveRun(rootSessionId).catch(() => undefined),
      this.refreshBackgroundTasks(rootSessionId, current.sessionId),
    ]);
    if (!this.isCurrent(sequence, current.sessionId)) return;
    this.rootRunActive = rootRun?.state === 'running' || rootRun?.state === 'decision-blocked';
    if (backgroundTasksChanged) this.publishProjection();
    this.scheduleBackgroundTaskPoll(current.sessionId);
  }

  async showTeam(): Promise<void> {
    if (this.stopped || !this.options.surfaceHost || !this.options.openSession) return;
    await this.refresh();
    if (this.stopped || this.teamScreen?.isActive()) return;
    let handle: TuiFeatureScreenHandle | undefined;
    const panel = new TuiAgentTeamPanel({
      snapshot: () => this.projection.snapshot(),
      activeSessionId: () => this.options.currentSession()?.sessionId,
      onSelect: async (sessionId) => {
        await this.options.openSession?.(sessionId);
        if (handle?.close()) this.teamScreen = undefined;
      },
      onCancel: () => {
        if (handle?.close()) this.teamScreen = undefined;
      },
      requestRender: this.options.onChanged,
    });
    handle = this.options.surfaceHost.pushFeature({ screen: panel, focus: panel });
    this.teamScreen = handle;
  }

  async showTasks(): Promise<void> {
    if (this.stopped || !this.options.surfaceHost) return;
    await this.refresh();
    if (this.stopped || this.tasksScreen?.isActive()) return;
    const screenGeneration = ++this.tasksScreenGeneration;
    let handle: TuiFeatureScreenHandle | undefined;
    const panel = new TuiBackgroundWorkPanel({
      agentTeam: () => this.projection.snapshot(),
      backgroundTasks: () => this.rootBackgroundTasks(),
      activeSessionId: () => this.options.currentSession()?.sessionId,
      onOpenAgent: (sessionId) => this.openAgentTranscript(sessionId, screenGeneration),
      onCancel: () => {
        if (handle?.close()) {
          this.tasksScreen = undefined;
          if (this.tasksScreenGeneration === screenGeneration) this.tasksScreenGeneration += 1;
        }
      },
      requestRender: this.options.onChanged,
    });
    handle = this.options.surfaceHost.pushFeature({ screen: panel, focus: panel });
    this.tasksScreen = handle;
  }

  private async openAgentTranscript(sessionId: string, screenGeneration: number): Promise<void> {
    if (
      this.stopped ||
      !this.options.surfaceHost ||
      screenGeneration !== this.tasksScreenGeneration ||
      !this.tasksScreen?.isActive() ||
      this.agentTranscriptScreen?.isActive() ||
      this.agentTranscriptLoadingGeneration === screenGeneration
    ) {
      return;
    }
    this.agentTranscriptLoadingGeneration = screenGeneration;
    try {
      const messages = await this.options.runtime.getMessages(sessionId, CHILD_HISTORY_LIMIT);
      if (
        this.stopped ||
        screenGeneration !== this.tasksScreenGeneration ||
        !this.tasksScreen?.isActive() ||
        !this.memberIds.has(sessionId)
      ) {
        return;
      }
      const transcript = new TranscriptStore();
      const projection = new TuiTurnProjection({
        transcript,
        now: () => Date.now(),
        onChange: () => undefined,
      });
      projection.hydrateHistory(messages);

      let handle: TuiFeatureScreenHandle | undefined;
      const panel = new TuiTranscriptPanel({
        source: transcript,
        onCancel: () => {
          if (handle?.close()) this.agentTranscriptScreen = undefined;
        },
        requestRender: this.options.onChanged,
        exportMetadata: {
          sessionId,
          title: this.projection.snapshot().members.find((member) => member.sessionId === sessionId)
            ?.agentName,
          exportedAtMs: Date.now(),
        },
      });
      handle = this.options.surfaceHost.pushFeature({ screen: panel, focus: panel });
      this.agentTranscriptScreen = handle;
    } catch (error) {
      this.options.onError?.(error);
    } finally {
      if (this.agentTranscriptLoadingGeneration === screenGeneration) {
        this.agentTranscriptLoadingGeneration = undefined;
      }
    }
  }

  permissionSessionScope(activeSessionId: string): ReadonlySet<string> {
    const scope = new Set<string>([activeSessionId]);
    if (this.options.currentSession()?.sessionId !== activeSessionId) return scope;
    const snapshot = this.projection.snapshot();
    if (!snapshot.rootSessionId) return scope;
    const childrenByParent = new Map<string, string[]>();
    for (const member of snapshot.members) {
      const children = childrenByParent.get(member.parentSessionId) ?? [];
      children.push(member.sessionId);
      childrenByParent.set(member.parentSessionId, children);
    }
    const stack = [activeSessionId];
    while (stack.length > 0) {
      const parentSessionId = stack.pop();
      if (!parentSessionId) continue;
      for (const childSessionId of childrenByParent.get(parentSessionId) ?? []) {
        if (scope.has(childSessionId)) continue;
        scope.add(childSessionId);
        stack.push(childSessionId);
      }
    }
    return scope;
  }

  async handleRuntimeEvent(event: TuiRuntimeEvent): Promise<void> {
    const current = this.options.currentSession();
    if (this.stopped || !current) return;
    // A newly created Session becomes current before its first Runtime lifecycle event,
    // but it does not pass through SessionFlow activation (which normally calls refresh()).
    // Adopt that root lazily so the first Turn starts background-task polling without
    // requiring the user to open /tasks first.
    if (
      !this.rootSessionId &&
      event.sessionId === current.sessionId &&
      !isTuiDelegatedSession(current) &&
      isSessionLifecycleEvent(event)
    ) {
      this.rootSessionId = current.sessionId;
    }
    if (event.sessionId === this.rootSessionId) {
      if (event.type === 'session.start') this.rootRunActive = true;
      if (
        event.type === 'session.finish' ||
        event.type === 'session.error' ||
        event.type === 'session.abort'
      ) {
        this.rootRunActive = false;
        this.backgroundTaskTerminalPollPending = true;
        if (this.options.runtime.listBackgroundTasks) {
          this.backgroundTaskListBarrier = this.backgroundTaskRequestSequence;
        }
      }
      this.scheduleBackgroundTaskPoll(current.sessionId);
    }
    if (
      event.type === 'session.created' &&
      (event.parentSessionId === current.sessionId ||
        event.parentSessionId === this.rootSessionId ||
        (event.parentSessionId !== undefined && this.memberIds.has(event.parentSessionId))) &&
      event.sessionType === 'branch' &&
      event.sessionKind === 'task'
    ) {
      await this.refresh();
      return;
    }
    if (!event.sessionId || !this.memberIds.has(event.sessionId)) return;
    if (event.type === 'permission.ask') {
      this.projection.markWaiting(event.sessionId, 'Waiting for approval', event.timestampMs);
      this.publishProjection();
      return;
    }
    if (event.type === 'questionnaire.ask') {
      this.projection.markWaiting(event.sessionId, 'Waiting for answers', event.timestampMs);
      this.publishProjection();
      return;
    }
    if (event.type === 'session.finish') {
      if (this.projection.markDone(event.sessionId, event.turnId, event.timestampMs)) {
        this.publishProjection();
      }
      await this.refresh();
      return;
    }
    if (
      event.type === 'session.start' ||
      event.type === 'session.error' ||
      event.type === 'session.abort' ||
      event.type === 'session.active_run.action' ||
      event.type === 'permission.resolved' ||
      event.type === 'questionnaire.dismiss' ||
      event.type === 'questionnaire.superseded'
    ) {
      await this.refresh();
    }
  }

  private reconcileWatchers(
    activeRuns: ReadonlyMap<string, TuiActiveRunSnapshot>,
    ownerSessionId: string,
  ): void {
    for (const [sessionId, watcher] of this.watchers) {
      const run = activeRuns.get(sessionId);
      if (
        !run?.turnId ||
        run.turnId !== watcher.turnId ||
        run.state === 'terminal' ||
        watcher.retiring
      ) {
        this.abortWatcher(watcher);
        this.watchers.delete(sessionId);
      }
    }
    for (const [sessionId, run] of activeRuns) {
      if (!run.turnId || (run.state !== 'running' && run.state !== 'decision-blocked')) continue;
      const existing = this.watchers.get(sessionId);
      if (existing?.turnId === run.turnId && !existing.retiring) continue;
      if (existing) this.abortWatcher(existing);
      const controller = new AbortController();
      const watcher: ChildWatcher = {
        sessionId,
        turnId: run.turnId,
        controller,
        retiring: false,
        task: Promise.resolve(),
      };
      watcher.task = this.consumeChildTurn(watcher, ownerSessionId).finally(() => {
        if (this.watchers.get(sessionId) === watcher) this.watchers.delete(sessionId);
      });
      this.watchers.set(sessionId, watcher);
    }
  }

  private async consumeChildTurn(watcher: ChildWatcher, ownerSessionId: string): Promise<void> {
    let afterMsgId: string | undefined;
    try {
      const messages = await this.options.runtime.getMessages(
        watcher.sessionId,
        CHILD_HISTORY_LIMIT,
      );
      if (!this.isWatcherCurrent(watcher, ownerSessionId)) return;
      this.projection.hydrateMessages(watcher.sessionId, watcher.turnId, messages, Date.now());
      afterMsgId = [...messages].reverse().find((message) => message.id)?.id;
      this.publishProjection();
    } catch {
      afterMsgId = undefined;
    }

    while (this.isWatcherCurrent(watcher, ownerSessionId)) {
      let resyncRequired = false;
      try {
        const stream = afterMsgId
          ? this.options.runtime.watchSessionTurn(
              watcher.sessionId,
              watcher.turnId,
              watcher.controller.signal,
              { afterMsgId },
            )
          : this.options.runtime.watchSessionTurn(
              watcher.sessionId,
              watcher.turnId,
              watcher.controller.signal,
            );
        for await (const event of stream) {
          if (!this.isWatcherCurrent(watcher, ownerSessionId)) return;
          if (event.type === 'resync-required') {
            resyncRequired = true;
            break;
          }
          this.projection.applyStreamEvent(watcher.sessionId, watcher.turnId, event, Date.now());
          this.publishProjection();
        }
      } catch {
        await this.scheduleWatcherRetry(watcher, ownerSessionId);
        return;
      }
      if (!resyncRequired) {
        await this.scheduleWatcherRetry(watcher, ownerSessionId);
        return;
      }
      try {
        const messages = await this.options.runtime.getMessages(
          watcher.sessionId,
          CHILD_HISTORY_LIMIT,
        );
        if (!this.isWatcherCurrent(watcher, ownerSessionId)) return;
        this.projection.hydrateMessages(watcher.sessionId, watcher.turnId, messages, Date.now());
        this.publishProjection();
      } catch {
        await this.scheduleWatcherRetry(watcher, ownerSessionId);
        return;
      }
      afterMsgId = undefined;
    }
  }

  private async scheduleWatcherRetry(watcher: ChildWatcher, ownerSessionId: string): Promise<void> {
    watcher.retiring = true;
    if (!this.isWatcherOwned(watcher, ownerSessionId)) return;
    let activeRun: TuiActiveRunSnapshot;
    try {
      activeRun = await this.options.runtime.getActiveRun(watcher.sessionId);
    } catch {
      this.scheduleTeamRefreshRetry(ownerSessionId);
      return;
    }
    if (
      !this.isWatcherOwned(watcher, ownerSessionId) ||
      activeRun.turnId !== watcher.turnId ||
      (activeRun.state !== 'running' && activeRun.state !== 'decision-blocked')
    ) {
      return;
    }
    this.scheduleTeamRefreshRetry(ownerSessionId);
  }

  private scheduleTeamRefreshRetry(ownerSessionId: string): void {
    if (
      this.watcherRetryTimer ||
      this.stopped ||
      this.options.currentSession()?.sessionId !== ownerSessionId
    ) {
      return;
    }
    const delayMs = Math.min(250 * 2 ** this.watcherRetryAttempt, 4_000);
    this.watcherRetryAttempt += 1;
    this.watcherRetryTimer = setTimeout(() => {
      this.watcherRetryTimer = undefined;
      if (this.stopped || this.options.currentSession()?.sessionId !== ownerSessionId) return;
      void this.refresh().finally(() => {
        if (this.refreshErrorReported) this.scheduleTeamRefreshRetry(ownerSessionId);
      });
    }, delayMs);
    this.watcherRetryTimer.unref?.();
  }

  private clearWatcherRetry(): void {
    this.watcherRetryAttempt = 0;
    if (this.watcherRetryTimer) clearTimeout(this.watcherRetryTimer);
    this.watcherRetryTimer = undefined;
  }

  private publishProjection(): void {
    this.options.onAgentTeamChanged?.(this.projection.snapshot());
    this.options.onBackgroundTasksChanged?.(this.rootBackgroundTasks());
    this.options.onChanged();
  }

  /** Human surfaces list sub-Agents as Agent Team members, not as Tasks. */
  private rootBackgroundTasks(): readonly TuiBackgroundTask[] {
    return this.backgroundTasks.filter((task) => task.kind !== 'subagent');
  }

  private async refreshBackgroundTasks(
    rootSessionId: string,
    ownerSessionId: string,
  ): Promise<boolean> {
    const list = this.options.runtime.listBackgroundTasks;
    if (!list) return false;
    const requestSequence = ++this.backgroundTaskRequestSequence;
    let tasks: readonly TuiBackgroundTask[];
    try {
      tasks = await (this.options.machineStatus
        ? list.call(this.options.runtime, rootSessionId, { machineStatus: true })
        : list.call(this.options.runtime, rootSessionId));
    } catch {
      return false;
    }
    if (
      this.stopped ||
      requestSequence !== this.backgroundTaskRequestSequence ||
      this.rootSessionId !== rootSessionId ||
      this.options.currentSession()?.sessionId !== ownerSessionId
    ) {
      return false;
    }
    const barrierCleared =
      this.backgroundTaskListBarrier !== undefined &&
      requestSequence > this.backgroundTaskListBarrier;
    if (barrierCleared) this.backgroundTaskListBarrier = undefined;
    if (sameBackgroundTasks(this.backgroundTasks, tasks)) {
      // Unchanged Tasks only need the status line to drop its settle barrier.
      if (barrierCleared) this.options.onChanged();
      return false;
    }
    this.backgroundTasks = tasks.map((task) => ({ ...task }));
    return true;
  }

  private scheduleBackgroundTaskPoll(ownerSessionId: string): void {
    if (
      this.backgroundTaskPollTimer ||
      this.backgroundTaskPollInFlight ||
      this.stopped ||
      !this.rootSessionId ||
      this.options.currentSession()?.sessionId !== ownerSessionId ||
      (!this.rootRunActive &&
        !hasPendingBackgroundTaskAttention(this.backgroundTasks) &&
        !this.backgroundTaskTerminalPollPending &&
        this.backgroundTaskListBarrier === undefined) ||
      !this.options.runtime.listBackgroundTasks
    ) {
      return;
    }
    this.backgroundTaskPollTimer = setTimeout(() => {
      this.backgroundTaskPollTimer = undefined;
      void this.pollBackgroundTasks(ownerSessionId);
    }, BACKGROUND_TASK_POLL_MS);
    this.backgroundTaskPollTimer.unref?.();
  }

  private async pollBackgroundTasks(ownerSessionId: string): Promise<void> {
    const rootSessionId = this.rootSessionId;
    if (!rootSessionId || this.backgroundTaskPollInFlight || this.stopped) return;
    this.backgroundTaskPollInFlight = true;
    this.backgroundTaskTerminalPollPending = false;
    try {
      if (await this.refreshBackgroundTasks(rootSessionId, ownerSessionId)) {
        this.publishProjection();
      }
    } finally {
      this.backgroundTaskPollInFlight = false;
      this.scheduleBackgroundTaskPoll(ownerSessionId);
    }
  }

  private clearBackgroundTaskPoll(): void {
    if (this.backgroundTaskPollTimer) clearTimeout(this.backgroundTaskPollTimer);
    this.backgroundTaskPollTimer = undefined;
    this.backgroundTaskPollInFlight = false;
    this.backgroundTaskTerminalPollPending = false;
    this.backgroundTaskRequestSequence += 1;
  }

  private async resolveRootSessionId(current: TuiSession): Promise<string> {
    let session = current;
    for (let depth = 0; depth < MAX_PARENT_DEPTH; depth += 1) {
      if (!isTuiDelegatedSession(session)) return session.sessionId;
      session = await this.options.runtime.getSession(session.parentSessionId);
    }
    return session.sessionId;
  }

  private isCurrent(sequence: number, ownerSessionId: string): boolean {
    return (
      !this.stopped &&
      sequence === this.refreshSequence &&
      this.options.currentSession()?.sessionId === ownerSessionId
    );
  }

  private isWatcherCurrent(watcher: ChildWatcher, ownerSessionId: string): boolean {
    return (
      !watcher.retiring &&
      !watcher.controller.signal.aborted &&
      this.isWatcherOwned(watcher, ownerSessionId)
    );
  }

  private isWatcherOwned(watcher: ChildWatcher, ownerSessionId: string): boolean {
    return (
      !watcher.controller.signal.aborted &&
      this.watchers.get(watcher.sessionId) === watcher &&
      !this.stopped &&
      this.options.currentSession()?.sessionId === ownerSessionId
    );
  }

  private abortWatcher(watcher: ChildWatcher): void {
    watcher.controller.abort();
  }

  private resetProjection(): void {
    for (const watcher of this.watchers.values()) this.abortWatcher(watcher);
    this.watchers.clear();
    this.projection.reset();
    this.rootSessionId = undefined;
    this.memberIds = new Set();
    this.backgroundTasks = [];
    this.rootRunActive = false;
    this.backgroundTaskListBarrier = undefined;
    this.clearWatcherRetry();
    this.clearBackgroundTaskPoll();
    this.options.onAgentTeamChanged?.(this.projection.snapshot());
    this.options.onBackgroundTasksChanged?.([]);
    this.tasksScreenGeneration += 1;
    if (this.teamScreen?.close()) this.teamScreen = undefined;
    if (this.tasksScreen?.close()) this.tasksScreen = undefined;
    if (this.agentTranscriptScreen?.close()) this.agentTranscriptScreen = undefined;
    this.agentTranscriptLoadingGeneration = undefined;
  }

  private reportRefreshError(error: unknown): void {
    if (this.refreshErrorReported) return;
    this.refreshErrorReported = true;
    this.options.onError?.(error);
  }
}

function isSessionLifecycleEvent(
  event: TuiRuntimeEvent,
): event is Extract<
  TuiRuntimeEvent,
  { readonly type: 'session.start' | 'session.finish' | 'session.error' | 'session.abort' }
> {
  return (
    event.type === 'session.start' ||
    event.type === 'session.finish' ||
    event.type === 'session.error' ||
    event.type === 'session.abort'
  );
}

function latestSuccessfulTurnId(messages: readonly TuiMessage[]): string | undefined {
  const latestTurnId = [...messages].reverse().find((message) => message.turnId)?.turnId;
  if (!latestTurnId) return undefined;
  return messages.some(
    (message) =>
      message.turnId === latestTurnId &&
      message.role === 'assistant' &&
      message.finishReason?.toLocaleLowerCase() === 'stop',
  )
    ? latestTurnId
    : undefined;
}

function sameBackgroundTasks(
  left: readonly TuiBackgroundTask[],
  right: readonly TuiBackgroundTask[],
): boolean {
  return (
    left.length === right.length &&
    left.every((task, index) => {
      const candidate = right[index];
      return (
        candidate !== undefined &&
        task.taskId === candidate.taskId &&
        task.kind === candidate.kind &&
        task.status === candidate.status &&
        task.description === candidate.description &&
        task.command === candidate.command &&
        task.updatedAtMs === candidate.updatedAtMs &&
        task.deliveredAtMs === candidate.deliveredAtMs &&
        task.lastError === candidate.lastError &&
        task.foreground === candidate.foreground &&
        task.childSessionId === candidate.childSessionId &&
        task.notification?.state === candidate.notification?.state &&
        task.notification?.turnId === candidate.notification?.turnId
      );
    })
  );
}

function hasPendingBackgroundTaskAttention(tasks: readonly TuiBackgroundTask[]): boolean {
  return tasks.some(
    (task) =>
      isActiveTaskStatus(task.status) ||
      (task.notification ? owesNotification(task) : task.deliveredAtMs === undefined),
  );
}

function isActiveTaskStatus(status: TuiBackgroundTask['status']): boolean {
  return status === 'queued' || status === 'running' || status === 'stopping';
}

/** Terminal Task whose root notification is not settled yet. */
function owesNotification(task: TuiBackgroundTask): boolean {
  return task.notification?.state === 'pending';
}
