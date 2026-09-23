import type {
  GoalTurnBinding,
  GoalTurnSignal,
  ThreadGoalBoundUsageResult,
  ThreadGoalSignalCollectionResult,
} from '@mavis/goal';

import type { LocalActiveTurnTiming } from '../turns/active-turn-timing.js';
import type { NoProgressBreakerDecision } from './breaker.js';

export type BoundGoalTurnKind = 'main' | 'budget-summary';

export interface BoundGoalTurn {
  readonly sessionId: string;
  readonly binding: GoalTurnBinding;
  readonly kind: BoundGoalTurnKind;
  readonly mainTurns: 0 | 1;
  graceStepsUsed: number;
}

export interface BoundTurnAccounting {
  readonly boundTurn: BoundGoalTurn;
  readonly activeSeconds: number;
  readonly result: ThreadGoalBoundUsageResult;
}

interface BoundTurnSignal {
  readonly sessionId: string;
  readonly signal: GoalTurnSignal;
}

/** One settled Turn's breaker outcome, kept so a settlement retry replays it. */
interface BoundTurnBreakerDecision {
  readonly sessionId: string;
  readonly decision: NoProgressBreakerDecision;
}

/** Owns all per-Turn Goal bindings, accounting receipts, and model proposals. */
export class GoalTurnContextRegistry {
  private readonly bindings = new Map<string, BoundGoalTurn>();
  private readonly accounting = new Map<string, BoundTurnAccounting>();
  private readonly signals = new Map<string, BoundTurnSignal>();
  private readonly breakerDecisions = new Map<string, BoundTurnBreakerDecision>();

  getBinding(turnId: string): BoundGoalTurn | undefined {
    return this.bindings.get(turnId);
  }

  setBinding(turnId: string, binding: BoundGoalTurn): void {
    this.bindings.set(turnId, binding);
  }

  deleteBinding(turnId: string): void {
    this.bindings.delete(turnId);
  }

  getAccounting(turnId: string): BoundTurnAccounting | undefined {
    return this.accounting.get(turnId);
  }

  hasAccounting(turnId: string): boolean {
    return this.accounting.has(turnId);
  }

  setAccounting(turnId: string, accounting: BoundTurnAccounting): void {
    this.accounting.set(turnId, accounting);
  }

  getSignal(turnId: string): GoalTurnSignal | undefined {
    return this.signals.get(turnId)?.signal;
  }

  /**
   * The breaker is a persisted counter, not a pure function of the Turn: it
   * advances the Goal epoch when it writes. A settlement retry (for example
   * after a transient continuation enqueue failure) reuses the accounting
   * receipt captured before that write, so re-running the breaker would either
   * count the same Turn twice or fail its CAS against its own epoch. Cache the
   * decision per Turn instead and replay it.
   */
  getBreakerDecision(turnId: string): NoProgressBreakerDecision | undefined {
    return this.breakerDecisions.get(turnId)?.decision;
  }

  setBreakerDecision(turnId: string, sessionId: string, decision: NoProgressBreakerDecision): void {
    this.breakerDecisions.set(turnId, { sessionId, decision });
  }

  collectSignal(turnId: string, signal: GoalTurnSignal): ThreadGoalSignalCollectionResult {
    const boundTurn = this.bindings.get(turnId);
    if (!boundTurn) return 'not_a_goal_turn';
    if (
      boundTurn.kind !== 'main' ||
      boundTurn.binding.goalId !== signal.goalId ||
      boundTurn.binding.objectiveDigest !== signal.objectiveDigest
    ) {
      return 'stale';
    }
    const previous = this.signals.get(turnId)?.signal;
    if (!previous || previous.type !== 'block_proposed' || signal.type === 'block_proposed') {
      this.signals.set(turnId, { sessionId: boundTurn.sessionId, signal });
    }
    return 'accepted';
  }

  finish(timing: Pick<LocalActiveTurnTiming, 'sessionId' | 'turnId'>): void {
    const accounting = this.accounting.get(timing.turnId);
    if (accounting?.boundTurn.sessionId === timing.sessionId) {
      this.accounting.delete(timing.turnId);
    }
    const binding = this.bindings.get(timing.turnId);
    if (binding?.sessionId === timing.sessionId) this.bindings.delete(timing.turnId);
    const signal = this.signals.get(timing.turnId);
    if (signal?.sessionId === timing.sessionId) this.signals.delete(timing.turnId);
    const breaker = this.breakerDecisions.get(timing.turnId);
    if (breaker?.sessionId === timing.sessionId) this.breakerDecisions.delete(timing.turnId);
  }
}
