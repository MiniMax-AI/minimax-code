import { writeTuiAutomationDiagnostic } from '../../application/automation-diagnostics.js';
import { tuiAccountNeedsLoginPrompt } from '../../application/login-gate.js';
import type { TuiChatSnapshot } from '../controller/chat-controller.js';
import type { TuiAgentInteractionReadback } from '../controller/interaction/interaction-flow.js';
import type { TuiState } from '../state/index.js';
import { tuiStatusWaitingFieldEnabled, type TuiAgentStatus } from '../shell/status-protocol.js';

const TUI_AGENT_COUNT_MAX = 9_999;

/**
 * Upper bound for holding a settled root Turn open while delegated work is still
 * in flight. Past it the terminal state is published anyway, so a Task that never
 * reports back degrades to the previous collect-early behaviour instead of
 * running into the harness timeout.
 */
const DELEGATED_HOLD_MAX_MS = 1_800_000;

/** Optional hold of terminal `done` state while delegated child sessions remain active. */
function delegatedHoldEnabled(configured: boolean): boolean {
  const raw = process.env.MCODE_TUI_STATUS_DELEGATED_HOLD;
  if (raw === '0') return false;
  if (raw === '1') return true;
  return configured;
}

function delegatedHoldMaxMs(): number {
  const raw = process.env.MCODE_TUI_STATUS_DELEGATED_HOLD_MAX_MS;
  const parsed = raw === undefined ? Number.NaN : Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DELEGATED_HOLD_MAX_MS;
}

export interface TuiAutomationStatusStoreOptions {
  readonly now?: () => number;
  readonly log?: (message: string) => void;
  /** Hold terminal states while delegated child sessions remain active. */
  readonly delegatedHold?: boolean;
}

export interface TuiAutomationStatusFacts {
  readonly snapshot: TuiChatSnapshot;
  readonly connection: Pick<TuiState['connection'], 'phase'>;
  readonly currentLiveRunId?: string;
  readonly runtimeStoppingRunId?: string;
  readonly runtimeQueuedCount: number;
  readonly runtimeQueueHandoffPending: boolean;
  readonly interaction?: TuiAgentInteractionReadback;
  readonly compacting: boolean;
  readonly retrying: boolean;
  readonly agentCounts?: {
    readonly active: number;
    readonly total: number;
    readonly waiting: number;
  };
  readonly backgroundTasks?: number;
}

export interface TuiAutomationStatusSnapshot {
  readonly seq: string;
  readonly status: TuiAgentStatus;
  /**
   * `error` caused by a missing login rather than a fatal failure. The `[V]`
   * line still reports `error`; human-facing outputs can say that login is
   * needed. Derived from current account facts, so it clears after login.
   */
  readonly loginRequired?: true;
  readonly sessionId?: string;
  readonly turnId?: string;
  readonly requestId?: string;
  readonly activeAgents: number;
  readonly totalAgents: number;
  /** Delegated Sessions blocked on a user decision; a subset of `activeAgents`. */
  readonly waitingAgents: number;
  readonly backgroundTasks: number;
}

type AutomationStatusTuple = Omit<TuiAutomationStatusSnapshot, 'seq'>;

/** Canonical facts plus the values `reconcile` derives before resolving a tuple. */
type ResolvedAutomationStatusFacts = TuiAutomationStatusFacts & {
  readonly sessionId?: string;
  readonly settledTurn?: TuiChatSnapshot['lastSettledTurn'];
  readonly activeTurnId?: string;
  readonly activeAgents: number;
  readonly totalAgents: number;
  readonly waitingAgents: number;
  readonly backgroundTasks: number;
};

/**
 * Stable machine projection for the `[V]` contract.
 *
 * This store consumes canonical controller/runtime facts only. Human activity
 * phases and transcript cells deliberately do not enter the projection, so UI
 * wording or partial Assistant output cannot manufacture a terminal outcome.
 */
export class TuiAutomationStatusStore {
  private initialized = false;
  private sessionId: string | undefined;
  private sequence = 0;
  private semanticKey: string | undefined;
  private pendingTurnId: string | undefined;
  private lastSettledTurnId: string | undefined;
  private stickyTerminal: Pick<AutomationStatusTuple, 'status' | 'turnId'> | undefined;
  private stickyFatalError = false;
  /** Both hold budgets belong to this Turn, including after its timeout expires. */
  private holdTurnId: string | undefined;
  private delegatedHoldSinceMs: number | undefined;
  private delegatedHoldExpired = false;
  /** When the current Turn started waiting for a root Turn that never settles. */
  private unsettledTurnSinceMs: number | undefined;
  private unsettledTurnExpired = false;

  constructor(private readonly options: TuiAutomationStatusStoreOptions = {}) {}

  reconcile(facts: TuiAutomationStatusFacts): TuiAutomationStatusSnapshot {
    const sessionId = facts.snapshot.session?.sessionId;
    if (!this.initialized || sessionId !== this.sessionId) this.resetForSession(sessionId);

    const settledTurn =
      facts.snapshot.lastSettledTurn?.sessionId === sessionId
        ? facts.snapshot.lastSettledTurn
        : undefined;
    const activeTurnId =
      facts.snapshot.activeTurnId ??
      facts.snapshot.retiringTurnId ??
      facts.runtimeStoppingRunId ??
      facts.currentLiveRunId;

    if (activeTurnId) {
      if (settledTurn && settledTurn.turnId !== activeTurnId) {
        this.lastSettledTurnId = settledTurn.turnId;
      }
      this.resetHoldForTurn(activeTurnId);
      this.pendingTurnId = activeTurnId;
      this.stickyTerminal = undefined;
    }
    const acceptedSettledTurn =
      settledTurn &&
      (!this.pendingTurnId ||
        settledTurn.turnId === this.pendingTurnId ||
        (this.unsettledTurnExpired && settledTurn.turnId !== this.lastSettledTurnId))
        ? settledTurn
        : undefined;
    if (acceptedSettledTurn) {
      this.resetHoldForTurn(acceptedSettledTurn.turnId);
      this.clearUnsettledTurnHold();
      this.pendingTurnId = undefined;
      this.lastSettledTurnId = acceptedSettledTurn.turnId;
      this.stickyTerminal = {
        status: terminalStatus(acceptedSettledTurn.status),
        turnId: acceptedSettledTurn.turnId,
      };
    }
    const settledFailure =
      acceptedSettledTurn?.status === 'failed' || acceptedSettledTurn?.status === 'blocked';
    if (
      facts.interaction?.kind === 'invalid' ||
      (facts.snapshot.status === 'error' &&
        !(facts.snapshot.account && tuiAccountNeedsLoginPrompt(facts.snapshot.account)) &&
        facts.snapshot.errorRetryable === false &&
        !activeTurnId &&
        !this.pendingTurnId &&
        !settledFailure)
    ) {
      this.stickyFatalError = true;
    }

    const totalAgents = boundedCount(facts.agentCounts?.total);
    const activeAgents = Math.min(boundedCount(facts.agentCounts?.active), totalAgents);
    const waitingAgents = Math.min(boundedCount(facts.agentCounts?.waiting), activeAgents);
    const tuple = withRuntimeTurnOnly(
      this.resolveTuple({
        ...facts,
        sessionId,
        settledTurn: acceptedSettledTurn,
        activeTurnId,
        activeAgents,
        totalAgents,
        waitingAgents,
        backgroundTasks: boundedCount(facts.backgroundTasks),
      }),
      facts.snapshot.unadmittedTurnId,
    );
    const semanticKey = tupleKey(
      tuple,
      this.delegatedHoldEnabled() || tuiStatusWaitingFieldEnabled(),
    );
    if (this.semanticKey === undefined) {
      this.semanticKey = semanticKey;
    } else if (semanticKey !== this.semanticKey) {
      this.sequence += 1;
      this.semanticKey = semanticKey;
    }
    return { seq: this.sequence.toString(36), ...tuple };
  }

  private resolveTuple(facts: ResolvedAutomationStatusFacts): AutomationStatusTuple {
    const counts = {
      activeAgents: facts.activeAgents,
      totalAgents: facts.totalAgents,
      waitingAgents: facts.waitingAgents,
      backgroundTasks: facts.backgroundTasks,
    };
    const session = facts.sessionId ? { sessionId: facts.sessionId } : {};

    // A disconnected or reconciling SSE projection cannot prove ready or terminal.
    if (facts.connection.phase !== 'live') {
      return { status: 'run', ...session, ...counts };
    }

    if (this.stickyFatalError) {
      return { status: 'error', ...session, ...counts };
    }

    // Login is recoverable within the same Session; derive it from current account facts.
    if (facts.snapshot.account && tuiAccountNeedsLoginPrompt(facts.snapshot.account)) {
      return { status: 'error', loginRequired: true, ...session, ...counts };
    }

    if (facts.snapshot.status === 'error') {
      const failedTurnId =
        facts.settledTurn?.status === 'failed' || facts.settledTurn?.status === 'blocked'
          ? facts.settledTurn.turnId
          : undefined;
      if (failedTurnId) return { status: 'fail', ...session, turnId: failedTurnId, ...counts };
      const pendingTurnId = facts.activeTurnId ?? this.pendingTurnId;
      return {
        status: 'run',
        ...session,
        ...(pendingTurnId ? { turnId: pendingTurnId } : {}),
        ...counts,
      };
    }

    if (facts.interaction) {
      const interactionBelongsToCurrentSession =
        !facts.interaction.ownerSessionId || facts.interaction.ownerSessionId === facts.sessionId;
      const turnId =
        facts.interaction.ownerTurnId ??
        (interactionBelongsToCurrentSession
          ? (facts.activeTurnId ?? this.pendingTurnId)
          : undefined);
      // A projected descendant permission may arrive before its active-run
      // reconciliation. Keep waiting without manufacturing a fatal error; the
      // request becomes actionable as soon as its owner turn is known.
      if (!turnId) return { status: 'run', ...session, ...counts };
      if (facts.interaction.submitting) {
        return { status: 'run', ...session, turnId, ...counts };
      }
      return {
        status:
          facts.interaction.kind === 'permission'
            ? 'perm'
            : facts.interaction.kind === 'plan'
              ? 'plan'
              : 'ask',
        ...session,
        turnId,
        requestId: facts.interaction.requestId,
        ...counts,
      };
    }

    if (
      facts.activeTurnId ||
      this.pendingTurnId ||
      facts.runtimeQueuedCount > 0 ||
      facts.runtimeQueueHandoffPending ||
      facts.compacting ||
      facts.retrying ||
      facts.snapshot.status === 'starting' ||
      facts.snapshot.status === 'running'
    ) {
      const turnId = facts.activeTurnId ?? this.pendingTurnId;
      const running: AutomationStatusTuple = {
        status: 'run',
        ...session,
        ...(turnId ? { turnId } : {}),
        ...counts,
      };
      if (this.isUnsettledRootTurn(facts)) return this.withUnsettledTurnHold(running);
      this.clearUnsettledTurnHold();
      return running;
    }
    this.clearUnsettledTurnHold();

    if (facts.settledTurn) {
      return this.withDelegatedHold({
        status: terminalStatus(facts.settledTurn.status),
        ...session,
        turnId: facts.settledTurn.turnId,
        ...counts,
      });
    }

    if (this.stickyTerminal?.turnId) {
      return this.withDelegatedHold({
        status: this.stickyTerminal.status,
        ...session,
        turnId: this.stickyTerminal.turnId,
        ...counts,
      });
    }

    return { status: 'ready', ...session, ...counts };
  }

  /** Holds `done` as `run` while delegated Sessions are active, up to the bounded timeout. */
  private withDelegatedHold(terminal: AutomationStatusTuple): AutomationStatusTuple {
    const outstanding = terminal.activeAgents > 0;
    if (terminal.status !== 'done' || !outstanding || !this.delegatedHoldEnabled()) {
      this.delegatedHoldSinceMs = undefined;
      return terminal;
    }
    if (this.delegatedHoldExpired) return terminal;

    const nowMs = this.options.now?.() ?? Date.now();
    this.delegatedHoldSinceMs ??= nowMs;
    const heldMs = nowMs - this.delegatedHoldSinceMs;
    const maxMs = delegatedHoldMaxMs();
    if (heldMs >= maxMs) {
      this.delegatedHoldExpired = true;
      this.logDelegatedHoldTimeout(terminal, heldMs, maxMs);
      return terminal;
    }
    return { ...terminal, status: 'run' };
  }

  private isUnsettledRootTurn(facts: ResolvedAutomationStatusFacts): boolean {
    return (
      this.pendingTurnId !== undefined &&
      !facts.activeTurnId &&
      facts.runtimeQueuedCount === 0 &&
      !facts.runtimeQueueHandoffPending &&
      !facts.compacting &&
      !facts.retrying &&
      facts.snapshot.status !== 'starting' &&
      facts.snapshot.status !== 'running'
    );
  }

  /** Missing settlement is a protocol error, never a fabricated Turn result. */
  private withUnsettledTurnHold(running: AutomationStatusTuple): AutomationStatusTuple {
    if (!this.delegatedHoldEnabled()) {
      this.clearUnsettledTurnHold();
      return running;
    }
    if (this.unsettledTurnExpired) return { ...running, status: 'error', turnId: undefined };

    const nowMs = this.options.now?.() ?? Date.now();
    this.unsettledTurnSinceMs ??= nowMs;
    const heldMs = nowMs - this.unsettledTurnSinceMs;
    const maxMs = delegatedHoldMaxMs();
    if (heldMs >= maxMs) {
      this.unsettledTurnExpired = true;
      this.logUnsettledTurnTimeout(running, heldMs, maxMs);
      return { ...running, status: 'error', turnId: undefined };
    }
    return running;
  }

  private delegatedHoldEnabled(): boolean {
    return delegatedHoldEnabled(this.options.delegatedHold === true);
  }

  private resetHoldForTurn(turnId: string): void {
    if (turnId === this.holdTurnId) return;
    this.holdTurnId = turnId;
    this.delegatedHoldSinceMs = undefined;
    this.delegatedHoldExpired = false;
    this.clearUnsettledTurnHold();
  }

  private clearUnsettledTurnHold(): void {
    this.unsettledTurnSinceMs = undefined;
    this.unsettledTurnExpired = false;
  }

  private logUnsettledTurnTimeout(
    running: AutomationStatusTuple,
    heldMs: number,
    maxMs: number,
  ): void {
    this.logDiagnostic(
      '[mcode-tui] automation status: root turn never settled; ' +
        `publishing state=error after ${heldMs}ms (limit ${maxMs}ms, ` +
        `activeAgents=${running.activeAgents}/${running.totalAgents}, ` +
        `backgroundTasks=${running.backgroundTasks}, turn=${running.turnId ?? 'none'})`,
    );
  }

  private logDelegatedHoldTimeout(
    terminal: AutomationStatusTuple,
    heldMs: number,
    maxMs: number,
  ): void {
    this.logDiagnostic(
      '[mcode-tui] automation status: delegated work never finished; ' +
        `publishing state=done after ${heldMs}ms (limit ${maxMs}ms, ` +
        `activeAgents=${terminal.activeAgents}/${terminal.totalAgents}, ` +
        `backgroundTasks=${terminal.backgroundTasks}, turn=${terminal.turnId ?? 'none'})`,
    );
  }

  private logDiagnostic(message: string): void {
    if (this.options.log) {
      this.options.log(message);
      return;
    }
    writeTuiAutomationDiagnostic(message);
  }

  private resetForSession(sessionId: string | undefined): void {
    this.initialized = true;
    this.sessionId = sessionId;
    this.sequence = 0;
    this.semanticKey = undefined;
    this.pendingTurnId = undefined;
    this.lastSettledTurnId = undefined;
    this.stickyTerminal = undefined;
    this.stickyFatalError = false;
    this.holdTurnId = undefined;
    this.delegatedHoldSinceMs = undefined;
    this.delegatedHoldExpired = false;
    this.unsettledTurnSinceMs = undefined;
    this.unsettledTurnExpired = false;
  }
}

/**
 * `turn` carries raw Runtime ids only. A TUI-generated id no Runtime frame has
 * confirmed still drives the state machine above, but is published as `none`;
 * waiting states need an owner turn, so they stay `run` until it is known.
 * A request exists only on waiting states and `loginRequired` only on `error`,
 * which never carries a turn, so the rebuilt tuple drops nothing else.
 */
function withRuntimeTurnOnly(
  tuple: AutomationStatusTuple,
  unadmittedTurnId: string | undefined,
): AutomationStatusTuple {
  if (!unadmittedTurnId || tuple.turnId !== unadmittedTurnId) return tuple;
  const waiting = tuple.status === 'perm' || tuple.status === 'ask' || tuple.status === 'plan';
  return {
    status: waiting ? 'run' : tuple.status,
    ...(tuple.sessionId ? { sessionId: tuple.sessionId } : {}),
    activeAgents: tuple.activeAgents,
    totalAgents: tuple.totalAgents,
    waitingAgents: tuple.waitingAgents,
    backgroundTasks: tuple.backgroundTasks,
  };
}

function terminalStatus(
  status: NonNullable<TuiChatSnapshot['lastSettledTurn']>['status'],
): 'done' | 'fail' | 'cancel' {
  if (status === 'succeeded') return 'done';
  if (status === 'cancelled') return 'cancel';
  return 'fail';
}

/** `waiting` moves `seq` only where a consumer can see or act on it, so other lines stay byte-identical. */
function tupleKey(tuple: AutomationStatusTuple, includeWaiting: boolean): string {
  return [
    tuple.status,
    tuple.sessionId ?? '',
    tuple.turnId ?? '',
    tuple.requestId ?? '',
    tuple.activeAgents,
    tuple.totalAgents,
    ...(includeWaiting ? [tuple.waitingAgents] : []),
    tuple.backgroundTasks,
  ].join('\u0000');
}

function boundedCount(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0;
  return Math.min(TUI_AGENT_COUNT_MAX, Math.max(0, Math.trunc(value)));
}
