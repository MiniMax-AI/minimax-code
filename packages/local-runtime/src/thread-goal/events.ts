/**
 * Thread-goal mutation event — emitted whenever the store is written
 * (create / patch / delete) so the host can drive the orchestrator
 * pause/resume signal and the SSE projection that updates the UI banner
 * in real time.
 *
 * Lives in its own module (rather than the route handler) so both the
 * IDL-generated DesktopService goal methods (`http/server.ts`) and the
 * host integration / bus wiring can depend on the event shape without a
 * cycle through the (now retired) hand-rolled REST router.
 */

import type {
  ThreadGoalState,
  ThreadGoalStatus,
  ThreadGoalStatusReason,
  ThreadGoalFailureClass,
} from '@mavis/goal';

import { logger } from '../common/logger.js';

export type ThreadGoalChangedEvent =
  | {
      type: 'created' | 'updated';
      goal: ThreadGoalState;
      /**
       * True iff this mutation changed the goal's `objective` text.
       * Only set on `'updated'` from the PATCH path; tool-path
       * mutations and pure status patches leave this `undefined`.
       *
       * The integration uses it to decide whether to inject the
       * `objective_updated` steering prompt (codex
       * `apply_external_goal_set::objective_changed` parity).
       */
      objectiveChanged?: boolean;
      /**
       * True iff this mutation came from the user-facing `/goal/*` PATCH.
       * Only that surface advances the Goal decision epoch while a Turn may
       * already be running, which invalidates the running Turn's binding and
       * cancels its queued follow-up. The continuation module uses the flag to
       * re-arm exactly one post-turn continuation so PATCH can never leave an
       * `active` Goal with no source of further execution.
       */
      userPatch?: boolean;
      /** Status reason observed immediately before a user PATCH resumed this Goal. */
      resumedFromReason?: ThreadGoalStatusReason;
    }
  | {
      type: 'deleted';
      goalId: string;
      sessionId: string;
      /** The mutation owner already retired the durable kickoff before deleting the Goal row. */
      kickoffCancelled?: boolean;
    };

export interface ThreadGoalRuntimeEventPayloadMap {
  'goal.created': {
    goalId: string;
    sessionId: string;
  };
  'goal.admission_decided': {
    goalId: string;
    sessionId: string;
    phase: 'queue_selection' | 'final_recheck';
    decision: 'ready' | 'deferred' | 'cancelled';
    reason?: string;
  };
  'goal.turn_bound': {
    goalId: string;
    sessionId: string;
    turnId: string;
    goalUpdatedAt: number;
  };
  'goal.turn_settled': {
    goalId: string;
    sessionId: string;
    turnId: string;
    status: 'completed' | 'failed' | 'aborted';
    failureClass?: ThreadGoalFailureClass;
    tokens: number;
    usageIncomplete?: boolean;
    activeSeconds?: number;
  };
  'goal.budget_decided': {
    goalId: string;
    sessionId: string;
    decision: 'within_limit' | 'limited';
    dimension?: 'token' | 'main_turn' | 'active_time';
    tokensUsed: number;
    turnsUsed: number;
    activeSeconds: number;
  };
  'goal.budget_updated': {
    goalId: string;
    sessionId: string;
    turnId: string;
    toolCallId?: string;
    oldTokenBudget: number | null;
    newTokenBudget: number | null;
    status: ThreadGoalStatus;
    resumed: boolean;
  };
  'goal.breaker_decided': {
    goalId: string;
    sessionId: string;
    action: 'none' | 'nudge' | 'pause' | 'skipped';
    /** Total occurrences including the first reply that established the fingerprint. */
    occurrences: number;
    /** Persisted same-reply observations after the first reply. */
    streak: number;
    /**
     * Observed tool activity for the settling Turn; `repeated` and `rerun` only
     * re-ran recent calls with the same result (`rerun` with possible side
     * effects), `unknown` is an observation gap.
     */
    toolActivity: 'used' | 'repeated' | 'rerun' | 'absent' | 'unknown';
    /** Persisted consecutive main turns that ended without new tool progress. */
    noToolStreak: number;
    /** Which independent condition decided a non-`none` action. */
    cause?: 'repeated_reply' | 'no_tool' | 'repeated_tool';
  };
  'goal.verification_dispatched': {
    goalId: string;
    sessionId: string;
    turnId: string;
    backend: 'evaluator' | 'subagent';
    goalUpdatedAt: number;
  };
  'goal.verification_child_started': {
    goalId: string;
    sessionId: string;
    turnId: string;
    backend: 'subagent';
    childSessionId: string;
    childTurnId?: string;
  };
  'goal.verification_decided': {
    goalId: string;
    sessionId: string;
    turnId: string;
    backend: 'evaluator' | 'subagent';
    source: 'verifier';
    verdict: 'met' | 'not_met' | 'impossible' | 'inconclusive';
    disposition: 'accepted' | 'budget_limited' | 'stale' | 'unavailable';
    failureCode?: string;
    /** Observed verification cost; verification is not charged to the Goal budget. */
    reportedTokens: number | null;
    usageIncomplete?: boolean;
    activeSeconds: number;
    childTurns?: number;
    childSessionId?: string;
    childTurnId?: string;
    reasonPresent: boolean;
    missingCount: number;
    missingFingerprint?: string;
    notMetStreak?: number;
  };
  'goal.worker_proposal_decided': {
    goalId: string;
    sessionId: string;
    turnId: string;
    source: 'worker';
    proposal: 'complete' | 'blocked';
    disposition: 'accepted' | 'stale';
    resultStatus?: ThreadGoalStatus;
    statusReason?: ThreadGoalStatusReason;
    summaryPresent: boolean;
    summaryDigest?: string;
  };
  'goal.state_transitioned': {
    goalId: string;
    sessionId: string;
    from: ThreadGoalStatus;
    to: ThreadGoalStatus;
    reason: ThreadGoalStatusReason;
  };
  'goal.continuation_submitted': {
    goalId: string;
    sessionId: string;
    turnId?: string;
    kind: 'kickoff' | 'active' | 'budget-limit' | 'recovery';
    clientRequestId: string;
  };
  'goal.reminder_injected': {
    goalId: string;
    sessionId: string;
    turnsUsed: number;
    reasons: Array<'recovery' | 'terminal-audit'>;
  };
  /**
   * An ordinary (non-Goal) queued item was parked by queue selection. Such
   * items have no Goal to project a wait reason onto, so this event is the
   * only durable trace explaining why a session queue stopped draining.
   */
  'goal.queue_item_deferred': {
    sessionId: string;
    reason: 'questionnaire_unresolved';
  };
}

export type ThreadGoalRuntimeEventType = keyof ThreadGoalRuntimeEventPayloadMap;

export type ThreadGoalRuntimeEvent<
  Type extends ThreadGoalRuntimeEventType = ThreadGoalRuntimeEventType,
> = {
  [EventType in Type]: {
    type: EventType;
    at: number;
    payload: ThreadGoalRuntimeEventPayloadMap[EventType];
  };
}[Type];

export type ThreadGoalRuntimeEventSink = (event: ThreadGoalRuntimeEvent) => void;

const logThreadGoalRuntimeEvent: ThreadGoalRuntimeEventSink = (event) => {
  logger.info({ goalEvent: event }, 'Thread Goal runtime decision');
};

/**
 * Emit non-sensitive Goal decision telemetry. These events intentionally stay
 * out of the public Global Events catalog: frontends consume only committed
 * `thread_goal.updated` state, while this stream records internal decisions.
 */
export function emitThreadGoalRuntimeEvent(
  event: ThreadGoalRuntimeEvent,
  sink?: ThreadGoalRuntimeEventSink,
): void {
  logThreadGoalRuntimeEvent(event);
  if (!sink) return;
  try {
    sink(event);
  } catch (error) {
    logger.warn(
      { eventType: event.type, error: error instanceof Error ? error.message : String(error) },
      'Thread Goal runtime observation failed open',
    );
  }
}
