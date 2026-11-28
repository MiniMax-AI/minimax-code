import type {
  PluginHookCommandHandler,
  PluginHookDecision,
  PluginHookEventInput,
  PluginHookRunResult,
  PluginHookLogger,
  PluginHookObserver,
  PluginHookSessionStartSource,
  PluginSubagentRegistration,
} from './contracts.js';
import { cleanupPluginHookSessionArtifacts } from './output-artifacts.js';
import { mergePluginHookDecisions, PluginHookRunner } from './runner.js';

const SESSION_IDLE_MS = 30 * 60 * 1_000;
const SESSION_END_BUDGET_MS = 3_000;
const SESSION_END_REPORT_BUDGET_MS = 1_000;
const SESSION_END_CONCURRENCY = 4;
const SESSION_END_FENCE_RETRY_MS = 1_000;
const SESSION_END_RESUME_DRAIN_BUDGET_MS = 2_000;
const MAX_RESUMABLE_SESSION_MARKERS = 1_024;

type PluginHookSessionEndReason = 'archive' | 'clear' | 'logout' | 'resume_other' | 'idle_timeout';

export interface PluginHookSessionEndFence {
  run(input: {
    readonly sessionId: string;
    readonly reason: PluginHookSessionEndReason;
    readonly idleSinceMs?: number;
    readonly sessionOwnershipClaim?: string;
    readonly operation: (signal?: AbortSignal) => Promise<PluginHookRunResult | undefined>;
  }): Promise<
    | { readonly status: 'executed'; readonly result?: PluginHookRunResult }
    | { readonly status: 'deferred'; readonly latestActivityAtMs?: number }
    | { readonly status: 'superseded' }
  >;
}

export interface PluginHookAdmissionTransaction {
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

interface ActivePlugin {
  readonly pluginName: string;
  readonly handlers: readonly PluginHookCommandHandler[];
  readonly cwd: string;
  readonly transcriptPath?: string | null;
  readonly codexTranscriptPath?: string | null;
  readonly model?: string;
  readonly permissionMode?: string;
  readonly effort?: PluginHookEventInput['effort'];
  readonly promptId?: string;
}

interface SessionState {
  readonly plugins: Map<string, ActivePlugin>;
  sessionOwnershipClaim?: string;
  pendingSessionEnd?: {
    readonly reason: Exclude<PluginHookSessionEndReason, 'idle_timeout'>;
    readonly enabledPluginNames?: ReadonlySet<string>;
  };
  transcriptCleanup?: () => Promise<void>;
  sessionEndCleanup?: () => Promise<void>;
  pendingCompactPluginIdentities?: ReadonlySet<string>;
  idleSinceMs?: number;
  suspendedIdleSinceMs?: number;
  turnActive: boolean;
  idleTimer?: ReturnType<typeof setTimeout>;
  idleEpoch: number;
  idleEndController?: AbortController;
}

export interface PluginHookCoordinatorOptions {
  /**
   * Desktop owns its 30-minute SessionEnd timer in-process. Cloud disables
   * this timer and runs SessionEnd from the sandbox idle-release fence so the
   * Hook still has a live sandbox in which to execute.
   */
  readonly automaticIdleSessionEnd?: boolean;
  /**
   * Best-effort host projection for SessionEnd output. Delivery is awaited
   * within a short independent budget so Cloud can persist the warning before
   * sandbox release without making Desktop lifecycle actions wait forever.
   */
  readonly onSessionEndResult?: (input: {
    readonly sessionId: string;
    readonly result?: PluginHookRunResult;
  }) => void | Promise<void>;
}

/**
 * Owns Plugin activation and the 30-minute idle SessionEnd rule. Turn callers
 * still pass their immutable handler snapshot to every event; this class never
 * re-reads mutable Plugin state in the middle of a turn.
 */
export class PluginHookCoordinator {
  private readonly sessions = new Map<string, SessionState>();
  private readonly endedSessions = new Set<string>();
  private readonly subagents = new Map<string, PluginSubagentRegistration>();
  private readonly idleEndControllers = new Map<string, AbortController>();
  private readonly idleEndTasks = new Map<string, Promise<void>>();
  private readonly explicitEndControllers = new Map<string, AbortController>();
  private readonly explicitEndTasks = new Map<string, Promise<PluginHookRunResult | undefined>>();
  private readonly forcedAutomaticCompactions = new Set<string>();
  private readonly pendingSessionStartSources = new Map<
    string,
    Exclude<PluginHookSessionStartSource, 'compact' | 'plugin_activation'>
  >();
  private readonly automaticIdleSessionEnd: boolean;
  private readonly onSessionEndResult?: PluginHookCoordinatorOptions['onSessionEndResult'];
  private resolveEnabledPluginNames?: () => ReadonlySet<string>;
  private sessionEndFence?: PluginHookSessionEndFence;

  constructor(
    private readonly runner: PluginHookRunner = new PluginHookRunner(),
    options: PluginHookCoordinatorOptions = {},
  ) {
    this.automaticIdleSessionEnd = options.automaticIdleSessionEnd ?? true;
    this.onSessionEndResult = options.onSessionEndResult;
  }

  configureObservability(input: {
    readonly logger?: PluginHookLogger;
    readonly observer?: PluginHookObserver;
  }): void {
    this.runner.configure(input);
  }

  setEnabledPluginResolver(resolve: (() => ReadonlySet<string>) | undefined): void {
    this.resolveEnabledPluginNames = resolve;
  }

  setSessionEndFence(fence: PluginHookSessionEndFence | undefined): void {
    this.sessionEndFence = fence;
  }

  /** Binds a prepared durable owner before its activation CAS is committed. */
  bindSessionOwnershipClaim(sessionId: string, ownershipClaimId: string): string | undefined {
    const state = this.sessions.get(sessionId);
    if (!state) return undefined;
    const previousClaim = state.sessionOwnershipClaim;
    state.sessionOwnershipClaim = ownershipClaimId;
    return previousClaim;
  }

  /** Restores the prior owner only when the failed candidate is still bound. */
  rollbackSessionOwnershipClaim(
    sessionId: string,
    failedOwnershipClaimId: string,
    previousOwnershipClaimId?: string,
  ): void {
    const state = this.sessions.get(sessionId);
    if (!state || state.sessionOwnershipClaim !== failedOwnershipClaimId) return;
    if (previousOwnershipClaimId) state.sessionOwnershipClaim = previousOwnershipClaimId;
    else delete state.sessionOwnershipClaim;
  }

  activeSessionIds(): readonly string[] {
    return [...this.sessions.keys()];
  }

  /** Returns root sessions plus every linked child execution that must be fenced with them. */
  activeExecutionSessionIds(rootSessionId?: string): readonly string[] {
    if (!rootSessionId) {
      return [...new Set([...this.sessions.keys(), ...this.subagents.keys()])];
    }
    const result = new Set<string>([rootSessionId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const registration of this.subagents.values()) {
        if (!result.has(registration.parentSessionId) || result.has(registration.childSessionId)) {
          continue;
        }
        result.add(registration.childSessionId);
        changed = true;
      }
    }
    return [...result];
  }

  hasActiveDescendantExecutions(rootSessionId: string): boolean {
    return this.activeExecutionSessionIds(rootSessionId).length > 1;
  }

  isSubagentSession(sessionId: string): boolean {
    return this.subagents.has(sessionId);
  }

  markNextSessionStart(
    sessionId: string,
    source: Exclude<PluginHookSessionStartSource, 'compact' | 'plugin_activation'>,
  ): void {
    this.pendingSessionStartSources.delete(sessionId);
    this.pendingSessionStartSources.set(sessionId, source);
    if (this.pendingSessionStartSources.size <= MAX_RESUMABLE_SESSION_MARKERS) return;
    const oldest = this.pendingSessionStartSources.keys().next().value as string | undefined;
    if (oldest) this.pendingSessionStartSources.delete(oldest);
  }

  deactivatePlugin(pluginName: string): void {
    for (const [sessionId, state] of this.sessions) {
      const removed = new Set<string>();
      for (const [identity, plugin] of state.plugins) {
        if (plugin.pluginName === pluginName) {
          void cleanupPluginHookSessionArtifacts(plugin.handlers, sessionId);
          state.plugins.delete(identity);
          removed.add(identity);
        }
      }
      if (state.pendingCompactPluginIdentities && removed.size > 0) {
        state.pendingCompactPluginIdentities = new Set(
          [...state.pendingCompactPluginIdentities].filter((identity) => !removed.has(identity)),
        );
        if (state.pendingCompactPluginIdentities.size === 0) {
          state.pendingCompactPluginIdentities = undefined;
        }
      }
    }
  }

  async beginTurn(input: {
    readonly handlers: readonly PluginHookCommandHandler[];
    readonly sessionId: string;
    readonly turnId: string;
    readonly cwd: string;
    readonly prompt: string;
    readonly transcriptPath?: string | null;
    readonly codexTranscriptPath?: string | null;
    readonly model?: string;
    readonly permissionMode?: string;
    readonly effort?: PluginHookEventInput['effort'];
    readonly promptId?: string;
    readonly resumeExistingSession?: boolean;
    readonly sessionStartSource?: Exclude<
      PluginHookSessionStartSource,
      'compact' | 'plugin_activation'
    >;
    readonly transcriptCleanup?: () => Promise<void>;
    /** Host-owned Session state cleared only after the logical SessionEnd Hook finishes. */
    readonly sessionEndCleanup?: () => Promise<void>;
    readonly sessionOwnershipClaim?: string;
    readonly captureAdmissionTransaction?: (transaction: PluginHookAdmissionTransaction) => void;
    readonly signal?: AbortSignal;
  }): Promise<PluginHookRunResult> {
    await this.drainExplicitSessionEndBeforeTurn(input.sessionId);
    const inherited = this.subagents.get(input.sessionId);
    if (inherited) return { decision: { decision: 'allow' }, diagnostics: [] };
    const idleEnd = this.idleEndTasks.get(input.sessionId);
    this.idleEndControllers.get(input.sessionId)?.abort('A new turn superseded idle SessionEnd');
    if (idleEnd) await idleEnd;
    const previousState = this.sessions.get(input.sessionId);
    const previousSnapshot = previousState ? snapshotSessionState(previousState) : undefined;
    const previousPendingStartSource = this.pendingSessionStartSources.get(input.sessionId);
    const wasEnded = this.endedSessions.has(input.sessionId);
    const wasKnownSession = previousState !== undefined;
    const isResume = this.endedSessions.delete(input.sessionId);
    const state = this.session(input.sessionId);
    let removedHandlersForCommit: readonly PluginHookCommandHandler[] = [];
    let admissionSettled = false;
    input.captureAdmissionTransaction?.({
      commit: async () => {
        if (admissionSettled) return;
        admissionSettled = true;
        if (removedHandlersForCommit.length > 0) {
          await cleanupPluginHookSessionArtifacts(removedHandlersForCommit, input.sessionId);
        }
      },
      rollback: async () => {
        if (admissionSettled) return;
        admissionSettled = true;
        await this.rollbackTurnAdmission({
          sessionId: input.sessionId,
          state,
          previousSnapshot,
          previousPendingStartSource,
          wasEnded,
        });
      },
    });
    if (input.sessionOwnershipClaim) state.sessionOwnershipClaim = input.sessionOwnershipClaim;
    if (input.transcriptCleanup) state.transcriptCleanup = input.transcriptCleanup;
    if (input.sessionEndCleanup) state.sessionEndCleanup = input.sessionEndCleanup;
    state.idleEpoch += 1;
    state.suspendedIdleSinceMs = state.idleSinceMs;
    state.idleSinceMs = undefined;
    state.turnActive = true;
    if (state.idleTimer) clearTimeout(state.idleTimer);
    state.idleTimer = undefined;
    this.idleEndControllers.delete(input.sessionId);
    state.idleEndController?.abort('A new turn superseded idle SessionEnd');
    state.idleEndController = undefined;
    const currentPlugins = groupByPlugin(input.handlers, input);
    const removedHandlers: PluginHookCommandHandler[] = [];
    for (const identity of [...state.plugins.keys()]) {
      if (currentPlugins.has(identity)) continue;
      const removed = state.plugins.get(identity);
      if (removed) removedHandlers.push(...removed.handlers);
      state.plugins.delete(identity);
    }
    if (removedHandlers.length > 0 && !input.captureAdmissionTransaction) {
      await cleanupPluginHookSessionArtifacts(removedHandlers, input.sessionId);
    } else {
      removedHandlersForCommit = removedHandlers;
    }
    const compactIdentities = state.pendingCompactPluginIdentities;
    const compacting = compactIdentities
      ? [...currentPlugins.entries()].filter(([identity]) => compactIdentities.has(identity))
      : [];
    const starting = [...currentPlugins.entries()].filter(
      ([identity]) => !state.plugins.has(identity) && !compactIdentities?.has(identity),
    );
    const pendingStartSource = this.pendingSessionStartSources.get(input.sessionId);
    this.pendingSessionStartSources.delete(input.sessionId);
    const startSource = resolveSessionStartSource(
      wasKnownSession,
      isResume || input.resumeExistingSession === true,
      pendingStartSource ?? (wasKnownSession ? undefined : input.sessionStartSource),
    );
    const startResults: PluginHookRunResult[] = [];
    let compactResult: PluginHookRunResult | undefined;
    if (compactIdentities) {
      state.pendingCompactPluginIdentities = undefined;
      if (compacting.length > 0) {
        compactResult = await this.runner.run(
          compacting.flatMap(([, plugin]) => plugin.handlers),
          eventInput('SessionStart', input, { source: 'compact' }, 'compact'),
          input.signal,
        );
        startResults.push(compactResult);
        if (stopsTurnLifecycle(compactResult)) {
          return mergeRunResults(startResults);
        }
      }
    }
    let activationResult: PluginHookRunResult | undefined;
    if (starting.length > 0) {
      activationResult = await this.runner.run(
        starting.flatMap(([, plugin]) => plugin.handlers),
        eventInput('SessionStart', input, { source: startSource }, startSource),
        input.signal,
      );
      startResults.push(activationResult);
    }
    const compactAborted = compactResult?.diagnostics.some(
      (diagnostic) => diagnostic.code === 'HOOK_ABORTED',
    );
    if (compactAborted && compactIdentities) {
      state.pendingCompactPluginIdentities = compactIdentities;
    }
    const activationAborted = activationResult?.diagnostics.some(
      (diagnostic) => diagnostic.code === 'HOOK_ABORTED',
    );
    for (const [identity, plugin] of currentPlugins) {
      if (state.plugins.has(identity) || !activationAborted) state.plugins.set(identity, plugin);
    }
    if (activationResult && stopsTurnLifecycle(activationResult)) {
      return mergeRunResults(startResults);
    }
    const promptResult = await this.runner.run(
      input.handlers,
      eventInput('UserPromptSubmit', input, { prompt: input.prompt }),
      input.signal,
    );
    return mergeRunResults([...startResults, promptResult]);
  }

  runEvent(
    handlers: readonly PluginHookCommandHandler[],
    input: PluginHookEventInput,
    signal?: AbortSignal,
  ): Promise<PluginHookRunResult> {
    const inherited = this.subagents.get(input.sessionId);
    if (!inherited) return this.runner.run(handlers, input, signal);
    return this.runner.run(
      inherited.handlers,
      {
        ...input,
        promptId: inherited.parentPromptId ?? inherited.parentTurnId,
        model: input.model ?? inherited.model,
        permissionMode: input.permissionMode ?? inherited.permissionMode,
        effort: input.effort ?? inherited.effort,
        subagentContext: registrationSubagentContext(inherited),
        payload: {
          ...(input.payload ?? {}),
          agent_id: inherited.agentId,
          agent_type: inherited.agentType,
        },
      },
      signal,
    );
  }

  async finishTurn(input: {
    readonly handlers: readonly PluginHookCommandHandler[];
    readonly sessionId: string;
    readonly turnId: string;
    readonly cwd: string;
    readonly transcriptPath?: string | null;
    readonly codexTranscriptPath?: string | null;
    readonly model?: string;
    readonly permissionMode?: string;
    readonly effort?: PluginHookEventInput['effort'];
    readonly promptId?: string;
    readonly stopHookActive?: boolean;
    readonly lastAssistantMessage?: string | null;
    readonly signal?: AbortSignal;
  }): Promise<PluginHookRunResult> {
    const inherited = this.subagents.get(input.sessionId);
    const hookInput = inherited
      ? {
          event: 'SubagentStop' as const,
          sessionId: input.sessionId,
          turnId: input.turnId,
          transcriptPath: inherited.agentTranscriptPath,
          codexTranscriptPath: inherited.agentCodexTranscriptPath,
          promptId: inherited.parentPromptId ?? inherited.parentTurnId,
          subagentContext: registrationSubagentContext(inherited),
          cwd: input.cwd,
          model: input.model ?? inherited.model,
          permissionMode: input.permissionMode ?? inherited.permissionMode,
          effort: input.effort ?? inherited.effort,
          matcherValue: inherited.agentType,
          payload: {
            stop_hook_active: input.stopHookActive ?? false,
            agent_id: inherited.agentId,
            agent_type: inherited.agentType,
            agent_transcript_path: inherited.agentTranscriptPath ?? null,
            last_assistant_message: input.lastAssistantMessage ?? null,
          },
        }
      : eventInput('Stop', input, {
          stop_hook_active: input.stopHookActive ?? false,
          last_assistant_message: input.lastAssistantMessage ?? null,
        });
    const result = await this.runner.run(
      inherited?.handlers ?? input.handlers,
      hookInput,
      input.signal,
    );
    return result;
  }

  completeTurn(sessionId: string): void {
    if (this.subagents.has(sessionId)) {
      this.releaseSubagent(sessionId);
      return;
    }
    const state = this.sessions.get(sessionId);
    if (state) {
      state.turnActive = false;
      state.suspendedIdleSinceMs = undefined;
      state.idleSinceMs = Date.now();
      const pending = state.pendingSessionEnd;
      this.scheduleSessionEnd(
        sessionId,
        state,
        pending ? SESSION_END_FENCE_RETRY_MS : SESSION_IDLE_MS,
        pending?.reason ?? 'idle_timeout',
        pending?.enabledPluginNames,
      );
    }
  }

  /** Suspends idle SessionEnd while a process-local compaction is active. */
  beginSessionActivity(sessionId: string, _turnId: string): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    state.idleEpoch += 1;
    state.suspendedIdleSinceMs = state.idleSinceMs;
    state.idleSinceMs = undefined;
    state.turnActive = true;
    if (state.idleTimer) clearTimeout(state.idleTimer);
    state.idleTimer = undefined;
  }

  completeSessionActivity(sessionId: string): void {
    this.completeTurn(sessionId);
  }

  /**
   * Restores the previous idle anchor after a denied, aborted, or failed turn.
   * Hosts call this when every Turn settles. For a subagent child the settled
   * Turn is its whole execution: a child that stops without a normal close
   * (for example a content-safety stop) must still release its registration,
   * otherwise the parent's SessionEnd stays fenced and an explicit SessionEnd
   * keeps rejecting every later parent Turn.
   */
  resumeIdleCountdown(sessionId: string): void {
    if (this.subagents.has(sessionId)) {
      this.releaseSubagent(sessionId);
      return;
    }
    const state = this.sessions.get(sessionId);
    if (!state) return;
    state.turnActive = false;
    if (state.idleSinceMs === undefined) {
      state.idleSinceMs = state.suspendedIdleSinceMs ?? Date.now();
    }
    state.suspendedIdleSinceMs = undefined;
    if (this.hasActiveDescendantExecutions(sessionId)) return;
    const pending = state.pendingSessionEnd;
    const remainingMs = pending
      ? SESSION_END_FENCE_RETRY_MS
      : Math.max(0, state.idleSinceMs + SESSION_IDLE_MS - Date.now());
    this.scheduleSessionEnd(
      sessionId,
      state,
      remainingMs,
      pending?.reason ?? 'idle_timeout',
      pending?.enabledPluginNames,
    );
  }

  markCompacted(sessionId: string, handlers: readonly PluginHookCommandHandler[]): void {
    this.session(sessionId).pendingCompactPluginIdentities = new Set(handlers.map(pluginIdentity));
  }

  admitAutomaticCompaction(sessionId: string, requestedDefer: boolean): boolean {
    const forced = this.forcedAutomaticCompactions.delete(sessionId);
    if (!requestedDefer) return true;
    if (forced) return true;
    this.forcedAutomaticCompactions.add(sessionId);
    return false;
  }

  completeAutomaticCompaction(sessionId: string): void {
    this.forcedAutomaticCompactions.delete(sessionId);
  }

  clearAutomaticCompactionDeferral(sessionId: string): void {
    this.forcedAutomaticCompactions.delete(sessionId);
  }

  handlersForTurn(
    sessionId: string,
    fallback: readonly PluginHookCommandHandler[],
  ): readonly PluginHookCommandHandler[] {
    return this.subagents.get(sessionId)?.handlers ?? fallback;
  }

  async startSubagent(
    registration: PluginSubagentRegistration,
    signal?: AbortSignal,
  ): Promise<PluginHookDecision> {
    this.subagents.set(registration.childSessionId, registration);
    const result = await this.runner.run(
      registration.handlers,
      {
        event: 'SubagentStart',
        sessionId: registration.childSessionId,
        turnId: registration.childTurnId,
        promptId: registration.parentPromptId ?? registration.parentTurnId,
        transcriptPath: registration.agentTranscriptPath,
        codexTranscriptPath: registration.agentCodexTranscriptPath,
        subagentContext: registrationSubagentContext(registration),
        cwd: registration.cwd,
        model: registration.model,
        permissionMode: registration.permissionMode,
        effort: registration.effort,
        matcherValue: registration.agentType,
        payload: {
          agent_id: registration.agentId,
          agent_type: registration.agentType,
        },
      },
      signal,
    );
    return result.decision;
  }

  cancelSubagent(childSessionId: string): void {
    this.releaseSubagent(childSessionId);
  }

  async endSession(
    sessionId: string,
    reason: PluginHookSessionEndReason,
    signal?: AbortSignal,
    enabledPluginNames?: ReadonlySet<string>,
  ): Promise<PluginHookRunResult | undefined> {
    if (reason !== 'idle_timeout') {
      const current = this.explicitEndTasks.get(sessionId);
      if (current) return current;
      const controller = new AbortController();
      this.explicitEndControllers.set(sessionId, controller);
      const task = this.performSessionEnd(
        sessionId,
        reason,
        combineAbortSignals(signal, controller.signal),
        enabledPluginNames,
      ).finally(() => {
        if (this.explicitEndTasks.get(sessionId) === task) {
          this.explicitEndTasks.delete(sessionId);
        }
        if (this.explicitEndControllers.get(sessionId) === controller) {
          this.explicitEndControllers.delete(sessionId);
        }
      });
      this.explicitEndTasks.set(sessionId, task);
      return task;
    }
    return this.performSessionEnd(sessionId, reason, signal, enabledPluginNames);
  }

  private async performSessionEnd(
    sessionId: string,
    reason: PluginHookSessionEndReason,
    signal?: AbortSignal,
    enabledPluginNames?: ReadonlySet<string>,
  ): Promise<PluginHookRunResult | undefined> {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    if (reason !== 'idle_timeout' && !state.pendingSessionEnd) {
      state.pendingSessionEnd = {
        reason,
        ...(enabledPluginNames ? { enabledPluginNames: new Set(enabledPluginNames) } : {}),
      };
    }
    const pending = state.pendingSessionEnd;
    const effectiveReason = pending?.reason ?? reason;
    const effectiveEnabledPluginNames = pending?.enabledPluginNames ?? enabledPluginNames;
    // An explicit lifecycle action is allowed to return before an active Turn
    // drains, but SessionEnd itself must not run concurrently with that Turn.
    // Keep retrying the request; completeTurn/resumeIdleCountdown will also
    // promptly re-arm it when the local Turn actually releases.
    if (
      effectiveReason !== 'idle_timeout' &&
      (state.turnActive || this.hasActiveDescendantExecutions(sessionId))
    ) {
      this.scheduleSessionEnd(
        sessionId,
        state,
        SESSION_END_FENCE_RETRY_MS,
        effectiveReason,
        effectiveEnabledPluginNames,
      );
      return undefined;
    }
    const operation = (fenceSignal?: AbortSignal) =>
      this.finishSessionEnd(
        sessionId,
        state,
        effectiveReason,
        combineAbortSignals(signal, fenceSignal),
        effectiveEnabledPluginNames,
      );
    if (!this.sessionEndFence) return operation();
    let outcome: Awaited<ReturnType<PluginHookSessionEndFence['run']>>;
    try {
      outcome = await this.sessionEndFence.run({
        sessionId,
        reason: effectiveReason,
        ...(state.idleSinceMs !== undefined ? { idleSinceMs: state.idleSinceMs } : {}),
        ...(state.sessionOwnershipClaim
          ? { sessionOwnershipClaim: state.sessionOwnershipClaim }
          : {}),
        operation,
      });
    } catch {
      outcome = { status: 'deferred' };
    }
    if (outcome.status === 'executed') return outcome.result;
    if (outcome.status === 'superseded') {
      await this.abandonSupersededSession(sessionId, state);
      return undefined;
    }
    if (this.sessions.get(sessionId) === state) {
      if (outcome.latestActivityAtMs !== undefined) {
        state.idleSinceMs = Math.max(state.idleSinceMs ?? 0, outcome.latestActivityAtMs);
      }
      const delayMs =
        effectiveReason === 'idle_timeout' && state.idleSinceMs !== undefined
          ? Math.max(SESSION_END_FENCE_RETRY_MS, state.idleSinceMs + SESSION_IDLE_MS - Date.now())
          : SESSION_END_FENCE_RETRY_MS;
      if (effectiveReason !== 'idle_timeout' || !state.turnActive) {
        this.scheduleSessionEnd(
          sessionId,
          state,
          delayMs,
          effectiveReason,
          effectiveEnabledPluginNames,
        );
      }
    }
    return undefined;
  }

  private async finishSessionEnd(
    sessionId: string,
    state: SessionState,
    reason: PluginHookSessionEndReason,
    signal: AbortSignal | undefined,
    enabledPluginNames: ReadonlySet<string> | undefined,
  ): Promise<PluginHookRunResult | undefined> {
    if (this.sessions.get(sessionId) !== state) return undefined;
    this.sessions.delete(sessionId);
    this.forcedAutomaticCompactions.delete(sessionId);
    this.markEnded(sessionId);
    if (state.idleTimer) clearTimeout(state.idleTimer);
    if (reason !== 'idle_timeout' && state.idleEndController) {
      state.idleEndController.abort('Session ended explicitly');
    }
    state.idleSinceMs = undefined;
    const enabled = enabledPluginNames ?? this.resolveEnabledPluginNames?.();
    const plugins = [...state.plugins.values()].filter(
      (plugin) => !enabled || enabled.has(plugin.pluginName),
    );
    const firstPlugin = plugins[0];
    let result: PluginHookRunResult | undefined;
    try {
      if (firstPlugin) {
        result = await this.runner.run(
          plugins.flatMap((plugin) => plugin.handlers),
          {
            event: 'SessionEnd',
            sessionId,
            transcriptPath: firstPlugin.transcriptPath,
            codexTranscriptPath: firstPlugin.codexTranscriptPath,
            cwd: firstPlugin.cwd,
            model: firstPlugin.model,
            permissionMode: firstPlugin.permissionMode,
            effort: firstPlugin.effort,
            promptId: firstPlugin.promptId,
            matcherValue: reason,
            payload: { reason },
          },
          signal,
        );
      }
    } finally {
      await this.reportSessionEndResult(sessionId, result);
      await cleanupSessionResources(state, sessionId);
      const idleController = this.idleEndControllers.get(sessionId);
      if (idleController?.signal === signal) this.idleEndControllers.delete(sessionId);
    }
    return result;
  }

  private async abandonSupersededSession(sessionId: string, state: SessionState): Promise<void> {
    if (this.sessions.get(sessionId) !== state) return;
    this.sessions.delete(sessionId);
    this.forcedAutomaticCompactions.delete(sessionId);
    this.markEnded(sessionId);
    if (state.idleTimer) clearTimeout(state.idleTimer);
    // The newer owner owns the logical SessionEnd command, but it cannot clear
    // Session-scoped permissions held in this stale process.
    await this.reportSessionEndResult(sessionId, undefined);
    await cleanupSessionResources(state, sessionId);
  }

  /**
   * Runs an idle SessionEnd as a cancellable admission fence. A new turn for
   * the same session aborts and drains this task before SessionStart, avoiding
   * overlapping old-session cleanup with a resumed turn.
   */
  async endIdleSession(
    sessionId: string,
    signal?: AbortSignal,
    enabledPluginNames?: ReadonlySet<string>,
  ): Promise<void> {
    const current = this.idleEndTasks.get(sessionId);
    if (current) return current;
    const state = this.sessions.get(sessionId);
    if (!state || state.turnActive || this.hasActiveDescendantExecutions(sessionId)) return;
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    state.idleEndController = controller;
    this.idleEndControllers.set(sessionId, controller);
    const task = this.endSession(
      sessionId,
      'idle_timeout',
      controller.signal,
      enabledPluginNames,
    ).then(() => undefined);
    this.idleEndTasks.set(sessionId, task);
    try {
      await task;
    } finally {
      signal?.removeEventListener('abort', abort);
      if (this.idleEndTasks.get(sessionId) === task) this.idleEndTasks.delete(sessionId);
      if (this.idleEndControllers.get(sessionId) === controller) {
        this.idleEndControllers.delete(sessionId);
      }
    }
  }

  /**
   * Ends the idle sessions owned by one sandbox release fence without
   * creating an unbounded burst of Hook processes. The shared deadline is a
   * release budget, not a per-session extension: remaining sessions are left
   * for the sandbox teardown once the budget expires.
   */
  async endIdleSessions(
    sessionIds: readonly string[],
    signal?: AbortSignal,
    enabledPluginNames?: ReadonlySet<string>,
  ): Promise<void> {
    const pendingSessions = [...new Set(sessionIds)].flatMap((sessionId) => {
      const state = this.sessions.get(sessionId);
      return state ? [{ sessionId, state, idleEpoch: state.idleEpoch }] : [];
    });
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(
      () => controller.abort('Plugin SessionEnd release deadline exceeded'),
      SESSION_END_BUDGET_MS,
    );
    let cursor = 0;
    try {
      await Promise.all(
        Array.from(
          { length: Math.min(SESSION_END_CONCURRENCY, pendingSessions.length) },
          async () => {
            while (cursor < pendingSessions.length && !controller.signal.aborted) {
              const candidate = pendingSessions[cursor];
              cursor += 1;
              if (!candidate) continue;
              const current = this.sessions.get(candidate.sessionId);
              if (
                current !== candidate.state ||
                current.idleEpoch !== candidate.idleEpoch ||
                current.turnActive ||
                this.hasActiveDescendantExecutions(candidate.sessionId)
              ) {
                continue;
              }
              await this.endIdleSession(candidate.sessionId, controller.signal, enabledPluginNames);
            }
          },
        ),
      );
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }

  async endAllSessions(
    reason: 'logout',
    signal?: AbortSignal,
    enabledPluginNames?: ReadonlySet<string>,
  ): Promise<void> {
    const sessionIds = [...this.sessions.keys()];
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(
      () => controller.abort('Plugin SessionEnd total deadline exceeded'),
      SESSION_END_BUDGET_MS,
    );
    let cursor = 0;
    try {
      await Promise.all(
        Array.from({ length: Math.min(SESSION_END_CONCURRENCY, sessionIds.length) }, async () => {
          while (cursor < sessionIds.length && !controller.signal.aborted) {
            const sessionId = sessionIds[cursor];
            cursor += 1;
            if (sessionId) {
              await this.endSession(sessionId, reason, controller.signal, enabledPluginNames);
            }
          }
        }),
      );
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      this.pruneSubagentsWithoutActiveRoot();
      // The foreground logout sweep has a fixed UX budget. Every session still
      // present (active, deferred, or not reached by a worker) must retry in
      // the background with its original explicit reason; deleting it would
      // skip both SessionEnd and session-permission cleanup.
      for (const sessionId of sessionIds) {
        const state = this.sessions.get(sessionId);
        if (!state) continue;
        if (!state.pendingSessionEnd) {
          state.pendingSessionEnd = {
            reason,
            ...(enabledPluginNames ? { enabledPluginNames: new Set(enabledPluginNames) } : {}),
          };
        }
        this.scheduleSessionEnd(
          sessionId,
          state,
          SESSION_END_FENCE_RETRY_MS,
          state.pendingSessionEnd.reason,
          state.pendingSessionEnd.enabledPluginNames,
        );
      }
    }
  }

  async dispose(): Promise<void> {
    const sessionStates = [...this.sessions].map(([sessionId, state]) => ({ sessionId, state }));
    for (const state of this.sessions.values()) if (state.idleTimer) clearTimeout(state.idleTimer);
    for (const state of this.sessions.values()) state.idleEndController?.abort('disposed');
    for (const controller of this.idleEndControllers.values()) controller.abort('disposed');
    for (const controller of this.explicitEndControllers.values()) controller.abort('disposed');
    await Promise.allSettled([...this.idleEndTasks.values(), ...this.explicitEndTasks.values()]);
    this.sessions.clear();
    this.endedSessions.clear();
    this.subagents.clear();
    this.idleEndControllers.clear();
    this.idleEndTasks.clear();
    this.explicitEndControllers.clear();
    this.explicitEndTasks.clear();
    this.forcedAutomaticCompactions.clear();
    this.pendingSessionStartSources.clear();
    this.resolveEnabledPluginNames = undefined;
    this.sessionEndFence = undefined;
    await Promise.allSettled(
      sessionStates.map((state) => cleanupSessionResources(state.state, state.sessionId)),
    );
    await this.runner.dispose();
  }

  private session(sessionId: string): SessionState {
    const current = this.sessions.get(sessionId);
    if (current) return current;
    const created: SessionState = { plugins: new Map(), idleEpoch: 0, turnActive: false };
    this.sessions.set(sessionId, created);
    return created;
  }

  private async drainExplicitSessionEndBeforeTurn(sessionId: string): Promise<void> {
    const current = this.explicitEndTasks.get(sessionId);
    if (current) {
      this.explicitEndControllers
        .get(sessionId)
        ?.abort('A new turn is waiting for explicit SessionEnd cleanup');
      const drained = await settlesWithin(current, SESSION_END_RESUME_DRAIN_BUDGET_MS);
      if (!drained) {
        throw new Error(`Previous Plugin SessionEnd is still finalizing: ${sessionId}`);
      }
    }
    if (this.sessions.get(sessionId)?.pendingSessionEnd) {
      // A prior explicit request was deferred while its Turn drained. Its retry
      // owns SessionEnd; admitting a replacement Turn here could starve that
      // retry and overlap old Session cleanup with the new session generation.
      throw new Error(`Previous Plugin SessionEnd is pending: ${sessionId}`);
    }
  }

  private async rollbackTurnAdmission(input: {
    readonly sessionId: string;
    readonly state: SessionState;
    readonly previousSnapshot?: SessionState;
    readonly previousPendingStartSource?: Exclude<
      PluginHookSessionStartSource,
      'compact' | 'plugin_activation'
    >;
    readonly wasEnded: boolean;
  }): Promise<void> {
    if (this.sessions.get(input.sessionId) !== input.state) return;
    if (input.state.idleTimer) clearTimeout(input.state.idleTimer);
    input.state.idleEndController?.abort('Plugin Hook admission rolled back');
    this.idleEndControllers.get(input.sessionId)?.abort('Plugin Hook admission rolled back');
    this.idleEndControllers.delete(input.sessionId);

    const currentHandlers = [...input.state.plugins.entries()]
      .filter(([identity]) => !input.previousSnapshot?.plugins.has(identity))
      .flatMap(([, plugin]) => plugin.handlers);
    const currentTranscriptCleanup = input.state.transcriptCleanup;
    const previousTranscriptCleanup = input.previousSnapshot?.transcriptCleanup;
    await Promise.allSettled([
      ...(currentTranscriptCleanup && currentTranscriptCleanup !== previousTranscriptCleanup
        ? [Promise.resolve().then(currentTranscriptCleanup)]
        : []),
      ...(currentHandlers.length > 0
        ? [cleanupPluginHookSessionArtifacts(currentHandlers, input.sessionId)]
        : []),
    ]);

    if (input.previousSnapshot) {
      const pendingSessionEnd =
        input.state.pendingSessionEnd ?? input.previousSnapshot.pendingSessionEnd;
      const restored = snapshotSessionState(input.previousSnapshot);
      restored.idleTimer = undefined;
      restored.idleEndController = undefined;
      if (pendingSessionEnd) restored.pendingSessionEnd = pendingSessionEnd;
      this.sessions.set(input.sessionId, restored);
    } else {
      this.sessions.delete(input.sessionId);
    }

    if (!this.pendingSessionStartSources.has(input.sessionId) && input.previousPendingStartSource) {
      this.pendingSessionStartSources.set(input.sessionId, input.previousPendingStartSource);
    }
    if (input.wasEnded) this.markEnded(input.sessionId);
    else this.endedSessions.delete(input.sessionId);
  }

  private pruneSubagentsWithoutActiveRoot(): void {
    for (const childSessionId of this.subagents.keys()) {
      let registration = this.subagents.get(childSessionId);
      const visited = new Set<string>([childSessionId]);
      let retained = false;
      while (registration) {
        if (this.sessions.has(registration.parentSessionId)) {
          retained = true;
          break;
        }
        if (visited.has(registration.parentSessionId)) break;
        visited.add(registration.parentSessionId);
        registration = this.subagents.get(registration.parentSessionId);
      }
      if (!retained) this.subagents.delete(childSessionId);
    }
  }

  private markEnded(sessionId: string): void {
    this.endedSessions.delete(sessionId);
    this.endedSessions.add(sessionId);
    if (this.endedSessions.size <= MAX_RESUMABLE_SESSION_MARKERS) return;
    const oldest = this.endedSessions.values().next().value as string | undefined;
    if (oldest) this.endedSessions.delete(oldest);
  }

  private releaseSubagent(childSessionId: string): void {
    const registration = this.subagents.get(childSessionId);
    if (!registration) return;
    this.subagents.delete(childSessionId);
    for (const [descendantId, descendant] of this.subagents) {
      if (descendant.parentSessionId !== childSessionId) continue;
      this.subagents.set(descendantId, {
        ...descendant,
        parentSessionId: registration.parentSessionId,
        parentTurnId: registration.parentTurnId,
      });
    }
    const parent = this.sessions.get(registration.parentSessionId);
    if (!parent || parent.turnActive || parent.idleSinceMs === undefined) return;
    const pending = parent.pendingSessionEnd;
    const remainingMs = pending
      ? SESSION_END_FENCE_RETRY_MS
      : Math.max(0, parent.idleSinceMs + SESSION_IDLE_MS - Date.now());
    this.scheduleSessionEnd(
      registration.parentSessionId,
      parent,
      remainingMs,
      pending?.reason ?? 'idle_timeout',
      pending?.enabledPluginNames,
    );
  }

  private scheduleSessionEnd(
    sessionId: string,
    state: SessionState,
    delayMs: number,
    reason: PluginHookSessionEndReason,
    enabledPluginNames?: ReadonlySet<string>,
  ): void {
    if (state.idleTimer) clearTimeout(state.idleTimer);
    if (!this.automaticIdleSessionEnd && reason === 'idle_timeout') {
      state.idleTimer = undefined;
      return;
    }
    if ([...this.subagents.values()].some((child) => child.parentSessionId === sessionId)) {
      state.idleTimer = undefined;
      return;
    }
    const epoch = ++state.idleEpoch;
    state.idleTimer = setTimeout(() => {
      if (this.sessions.get(sessionId) !== state || state.idleEpoch !== epoch) return;
      void (reason === 'idle_timeout'
        ? this.endIdleSession(
            sessionId,
            undefined,
            enabledPluginNames ?? this.resolveEnabledPluginNames?.(),
          )
        : this.endSession(
            sessionId,
            reason,
            undefined,
            enabledPluginNames ?? this.resolveEnabledPluginNames?.(),
          ));
    }, delayMs);
    state.idleTimer.unref?.();
  }

  private async reportSessionEndResult(
    sessionId: string,
    result: PluginHookRunResult | undefined,
  ): Promise<void> {
    if (!this.onSessionEndResult) return;
    try {
      await settleWithin(
        Promise.resolve(this.onSessionEndResult({ sessionId, ...(result ? { result } : {}) })),
        SESSION_END_REPORT_BUDGET_MS,
      );
    } catch {
      // User-visible diagnostics are best-effort and must never fail teardown.
    }
  }
}

function combineAbortSignals(
  caller: AbortSignal | undefined,
  fence: AbortSignal | undefined,
): AbortSignal | undefined {
  if (!caller) return fence;
  if (!fence) return caller;
  return AbortSignal.any([caller, fence]);
}

async function settleWithin(value: Promise<unknown>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    value.then(
      () => undefined,
      () => undefined,
    ),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
      timer.unref?.();
    }),
  ]);
  if (timer) clearTimeout(timer);
}

async function settlesWithin(value: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      value.then(
        () => true,
        () => true,
      ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function cleanupSessionResources(state: SessionState, sessionId: string): Promise<void> {
  const cleanup = state.transcriptCleanup;
  state.transcriptCleanup = undefined;
  const sessionEndCleanup = state.sessionEndCleanup;
  state.sessionEndCleanup = undefined;
  const handlers = [...state.plugins.values()].flatMap((plugin) => plugin.handlers);
  await Promise.allSettled([
    ...(cleanup ? [Promise.resolve().then(cleanup)] : []),
    ...(sessionEndCleanup ? [Promise.resolve().then(sessionEndCleanup)] : []),
    cleanupPluginHookSessionArtifacts(handlers, sessionId),
  ]);
}

function snapshotSessionState(state: SessionState): SessionState {
  return {
    plugins: new Map(state.plugins),
    ...(state.sessionOwnershipClaim ? { sessionOwnershipClaim: state.sessionOwnershipClaim } : {}),
    ...(state.pendingSessionEnd
      ? {
          pendingSessionEnd: {
            reason: state.pendingSessionEnd.reason,
            ...(state.pendingSessionEnd.enabledPluginNames
              ? { enabledPluginNames: new Set(state.pendingSessionEnd.enabledPluginNames) }
              : {}),
          },
        }
      : {}),
    ...(state.transcriptCleanup ? { transcriptCleanup: state.transcriptCleanup } : {}),
    ...(state.sessionEndCleanup ? { sessionEndCleanup: state.sessionEndCleanup } : {}),
    ...(state.pendingCompactPluginIdentities
      ? { pendingCompactPluginIdentities: new Set(state.pendingCompactPluginIdentities) }
      : {}),
    ...(state.idleSinceMs !== undefined ? { idleSinceMs: state.idleSinceMs } : {}),
    ...(state.suspendedIdleSinceMs !== undefined
      ? { suspendedIdleSinceMs: state.suspendedIdleSinceMs }
      : {}),
    turnActive: state.turnActive,
    ...(state.idleTimer ? { idleTimer: state.idleTimer } : {}),
    idleEpoch: state.idleEpoch,
    ...(state.idleEndController ? { idleEndController: state.idleEndController } : {}),
  };
}

function registrationSubagentContext(
  registration: PluginSubagentRegistration,
): NonNullable<PluginHookEventInput['subagentContext']> {
  return {
    parentSessionId: registration.parentSessionId,
    parentTurnId: registration.parentTurnId,
    parentTranscriptPath: registration.parentTranscriptPath,
    parentCodexTranscriptPath: registration.parentCodexTranscriptPath,
    childSessionId: registration.childSessionId,
    childTranscriptPath: registration.agentTranscriptPath,
    childCodexTranscriptPath: registration.agentCodexTranscriptPath,
  };
}

function stopsTurnLifecycle(result: PluginHookRunResult): boolean {
  return result.decision.continue === false || result.decision.decision === 'deny';
}

function resolveSessionStartSource(
  wasKnownSession: boolean,
  isResume: boolean,
  explicitSource?: Exclude<PluginHookSessionStartSource, 'compact' | 'plugin_activation'>,
): PluginHookSessionStartSource {
  if (explicitSource) return explicitSource;
  if (wasKnownSession) return 'plugin_activation';
  return isResume ? 'resume' : 'startup';
}

function groupByPlugin(
  handlers: readonly PluginHookCommandHandler[],
  runtime: {
    readonly cwd: string;
    readonly transcriptPath?: string | null;
    readonly codexTranscriptPath?: string | null;
    readonly model?: string;
    readonly permissionMode?: string;
    readonly effort?: PluginHookEventInput['effort'];
    readonly promptId?: string;
  },
): Map<string, ActivePlugin> {
  const grouped = new Map<string, PluginHookCommandHandler[]>();
  for (const handler of handlers) {
    const identity = pluginIdentity(handler);
    const values = grouped.get(identity) ?? [];
    values.push(handler);
    grouped.set(identity, values);
  }
  const result = new Map<string, ActivePlugin>();
  for (const [identity, values] of grouped) {
    const first = values[0];
    if (first) {
      result.set(identity, {
        pluginName: first.pluginName,
        handlers: values,
        cwd: runtime.cwd,
        transcriptPath: runtime.transcriptPath,
        codexTranscriptPath: runtime.codexTranscriptPath,
        model: runtime.model,
        permissionMode: runtime.permissionMode,
        effort: runtime.effort,
        promptId: runtime.promptId,
      });
    }
  }
  return result;
}

function pluginIdentity(handler: PluginHookCommandHandler): string {
  return JSON.stringify([handler.pluginName, handler.pluginRoot, handler.activationKey ?? '']);
}

function mergeRunResults(results: readonly PluginHookRunResult[]): PluginHookRunResult {
  const decision = results.reduce(
    (current, result) => mergePluginHookDecisions(current, result.decision),
    { decision: 'allow' } as PluginHookDecision,
  );
  return {
    decision,
    diagnostics: results.flatMap((result) => result.diagnostics),
  };
}

function eventInput(
  event: PluginHookEventInput['event'],
  input: {
    readonly sessionId: string;
    readonly turnId: string;
    readonly cwd: string;
    readonly transcriptPath?: string | null;
    readonly codexTranscriptPath?: string | null;
    readonly model?: string;
    readonly permissionMode?: string;
    readonly effort?: PluginHookEventInput['effort'];
    readonly promptId?: string;
  },
  payload: Readonly<Record<string, unknown>>,
  matcherValue?: string,
): PluginHookEventInput {
  return {
    event,
    sessionId: input.sessionId,
    turnId: input.turnId,
    transcriptPath: input.transcriptPath,
    codexTranscriptPath: input.codexTranscriptPath,
    cwd: input.cwd,
    model: input.model,
    permissionMode: input.permissionMode,
    effort: input.effort,
    promptId: input.promptId,
    ...(matcherValue ? { matcherValue } : {}),
    payload,
  };
}
