import type { PiTurnRunnerLogger } from '@mavis/agent-core/pi-turn-runner';
import type {
  RunawayGuardObservation,
  RunawayGuardReminderObservation,
  RunawayGuardTurnSummary,
} from '@mavis/agent-extension';

export interface RunawayGuardObserverOptions {
  readonly logger?: PiTurnRunnerLogger;
  readonly reportEvent?: (
    sessionId: string,
    event: {
      readonly eventType: string;
      readonly payload: Readonly<Record<string, unknown>>;
    },
  ) => void;
}

/** Whitelist-only projection; logging and Eval delivery fail independently. */
export function createRunawayGuardObserver(options: RunawayGuardObserverOptions) {
  return (
    event: string,
    observation:
      | RunawayGuardObservation
      | RunawayGuardReminderObservation
      | RunawayGuardTurnSummary,
  ) => {
    const payload = {
      schema_version: observation.schemaVersion,
      policy_version: 'runaway-v1',
      session_id: observation.sessionId,
      turn_id: observation.turnId,
      agent_name: observation.agentName,
      ...('signalKind' in observation
        ? {
            signal_kind: observation.signalKind,
            step_index: observation.stepIndex,
            occurrences: observation.occurrences,
          }
        : {
            step_count: observation.stepCount,
            projection_skipped_count: observation.projectionSkippedCount,
            child_steps_projected: observation.childStepsProjected,
            reminder_injected: observation.reminderInjected,
            signals: observation.signals,
          }),
      ...('action' in observation ? { action: observation.action, delivery: 'queued' } : {}),
    };
    try {
      options.logger?.info?.({ event, ...payload }, '[runaway-guard] observation');
    } catch {
      /* fail open */
    }
    try {
      options.reportEvent?.(observation.sessionId, { eventType: event, payload });
    } catch {
      /* fail open */
    }
  };
}
