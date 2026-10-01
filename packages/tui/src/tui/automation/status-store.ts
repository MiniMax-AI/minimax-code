import { tuiAccountNeedsLoginPrompt } from '../../application/login-gate.js';
import type { TuiChatSnapshot } from '../controller/chat-controller.js';
import type { TuiAgentInteractionReadback } from '../controller/interaction/interaction-flow.js';
import type { TuiState } from '../state/index.js';
import type { TuiAgentStatus } from '../shell/status-protocol.js';

const TUI_AGENT_COUNT_MAX = 9_999;

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
  readonly agentCounts?: { readonly active: number; readonly total: number };
  readonly backgroundTasks?: number;
}

export interface TuiAutomationStatusSnapshot {
  readonly seq: string;
  readonly status: TuiAgentStatus;
  readonly sessionId?: string;
  readonly turnId?: string;
  readonly requestId?: string;
  readonly activeAgents: number;
  readonly totalAgents: number;
  readonly backgroundTasks: number;
}

type AutomationStatusTuple = Omit<TuiAutomationStatusSnapshot, 'seq'>;

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
  private stickyTerminal: Pick<AutomationStatusTuple, 'status' | 'turnId'> | undefined;
  private stickyFatalError = false;

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
      this.pendingTurnId = activeTurnId;
      this.stickyTerminal = undefined;
    }
    const acceptedSettledTurn =
      settledTurn && (!this.pendingTurnId || settledTurn.turnId === this.pendingTurnId)
        ? settledTurn
        : undefined;
    if (acceptedSettledTurn) {
      this.pendingTurnId = undefined;
      this.stickyTerminal = {
        status: terminalStatus(acceptedSettledTurn.status),
        turnId: acceptedSettledTurn.turnId,
      };
    }
    const settledFailure =
      acceptedSettledTurn?.status === 'failed' || acceptedSettledTurn?.status === 'blocked';
    if (
      facts.interaction?.kind === 'invalid' ||
      (facts.snapshot.account && tuiAccountNeedsLoginPrompt(facts.snapshot.account)) ||
      (facts.snapshot.status === 'error' &&
        facts.snapshot.errorRetryable === false &&
        !activeTurnId &&
        !this.pendingTurnId &&
        !settledFailure)
    ) {
      this.stickyFatalError = true;
    }

    const totalAgents = boundedCount(facts.agentCounts?.total);
    const activeAgents = Math.min(boundedCount(facts.agentCounts?.active), totalAgents);
    const tuple = this.resolveTuple({
      ...facts,
      sessionId,
      settledTurn: acceptedSettledTurn,
      activeTurnId,
      activeAgents,
      totalAgents,
      backgroundTasks: boundedCount(facts.backgroundTasks),
    });
    const semanticKey = tupleKey(tuple);
    if (this.semanticKey === undefined) {
      this.semanticKey = semanticKey;
    } else if (semanticKey !== this.semanticKey) {
      this.sequence += 1;
      this.semanticKey = semanticKey;
    }
    return { seq: this.sequence.toString(36), ...tuple };
  }

  private resolveTuple(
    facts: TuiAutomationStatusFacts & {
      readonly sessionId?: string;
      readonly settledTurn?: TuiChatSnapshot['lastSettledTurn'];
      readonly activeTurnId?: string;
      readonly activeAgents: number;
      readonly totalAgents: number;
      readonly backgroundTasks: number;
    },
  ): AutomationStatusTuple {
    const counts = {
      activeAgents: facts.activeAgents,
      totalAgents: facts.totalAgents,
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
      return { status: 'run', ...session, ...(turnId ? { turnId } : {}), ...counts };
    }

    if (facts.settledTurn) {
      return {
        status: terminalStatus(facts.settledTurn.status),
        ...session,
        turnId: facts.settledTurn.turnId,
        ...counts,
      };
    }

    if (this.stickyTerminal?.turnId) {
      return {
        status: this.stickyTerminal.status,
        ...session,
        turnId: this.stickyTerminal.turnId,
        ...counts,
      };
    }

    return { status: 'ready', ...session, ...counts };
  }

  private resetForSession(sessionId: string | undefined): void {
    this.initialized = true;
    this.sessionId = sessionId;
    this.sequence = 0;
    this.semanticKey = undefined;
    this.pendingTurnId = undefined;
    this.stickyTerminal = undefined;
    this.stickyFatalError = false;
  }
}

function terminalStatus(
  status: NonNullable<TuiChatSnapshot['lastSettledTurn']>['status'],
): 'done' | 'fail' | 'cancel' {
  if (status === 'succeeded') return 'done';
  if (status === 'cancelled') return 'cancel';
  return 'fail';
}

function tupleKey(tuple: AutomationStatusTuple): string {
  return [
    tuple.status,
    tuple.sessionId ?? '',
    tuple.turnId ?? '',
    tuple.requestId ?? '',
    tuple.activeAgents,
    tuple.totalAgents,
    tuple.backgroundTasks,
  ].join('\u0000');
}

function boundedCount(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0;
  return Math.min(TUI_AGENT_COUNT_MAX, Math.max(0, Math.trunc(value)));
}
