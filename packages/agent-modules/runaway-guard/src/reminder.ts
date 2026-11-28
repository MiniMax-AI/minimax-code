import type {
  ReminderCandidates,
  RunawayGuardReminder,
  RunawayGuardReminderSignalKind,
  RunawayGuardRunIdentity,
  RunawayGuardSignalKind,
} from './contracts.js';
import type { ShadowState } from './state.js';

const REMINDER_CANDIDATE_PRIORITY: readonly RunawayGuardReminderSignalKind[] = [
  'unchanged_progress_repeat',
  'same_error_family',
  'exact_action_repeat',
  'polling_repeat',
];

export function takePreferredReminder(
  candidates: ReminderCandidates,
  ctx: RunawayGuardRunIdentity,
  state: ShadowState,
  afterOccurrences: number,
): RunawayGuardReminder | undefined {
  for (const signalKind of REMINDER_CANDIDATE_PRIORITY) {
    if (!candidates.has(signalKind)) continue;
    const content = reminderContent(signalKind, afterOccurrences);
    if (!content || state.reminderAttempted) return undefined;
    // Reserve before the adapter calls steer: a failed attempt must not retry.
    state.reminderAttempted = true;
    return {
      content,
      observation: {
        schemaVersion: 1,
        sessionId: ctx.sessionId,
        turnId: ctx.turnId,
        agentName: ctx.agentName,
        signalKind,
        stepIndex: state.stepIndex,
        occurrences: afterOccurrences,
        action: 'steer',
      },
    };
  }
  return undefined;
}

export function isReminderSignalKind(
  signalKind: RunawayGuardSignalKind,
): signalKind is RunawayGuardReminderSignalKind {
  return REMINDER_CANDIDATE_PRIORITY.includes(signalKind as RunawayGuardReminderSignalKind);
}

function reminderContent(
  signalKind: RunawayGuardSignalKind,
  occurrences: number | undefined,
): string | undefined {
  if (signalKind === 'polling_repeat') return pollingReminderContent(occurrences);
  const guidance = reminderGuidance(signalKind, occurrences);
  return guidance
    ? `${guidance} This is a temporary runtime reminder for the current Turn only, not a user preference or a durable rule; do not save this reminder or generalize it into Memory, Skills, or other persistent instruction files for future Turns or sessions.`
    : undefined;
}

function pollingReminderContent(occurrences: number | undefined): string | undefined {
  if (!occurrences) return undefined;
  const count = occurrences === 3 ? 'Three' : String(occurrences);
  return `<system-reminder>
${count} consecutive reads of the same background task have occurred. Stop polling and wait for the automatic completion notification.
This reminder applies only to the current Turn. Do not save or generalize it into Memory, Skills, or other persistent instructions.
</system-reminder>`;
}

function reminderGuidance(
  signalKind: RunawayGuardSignalKind,
  occurrences: number | undefined,
): string | undefined {
  if (!occurrences) return undefined;
  if (signalKind === 'exact_action_repeat') {
    return (
      `[runaway guard] The immediately repeated tool action has now occurred ${occurrences} ` +
      'times with the same arguments. Do not repeat it unchanged. Inspect the results already ' +
      'available, then either change strategy with a concrete expected state change, or report the ' +
      'blocker. Repetition alone does not establish that the task is complete or impossible.'
    );
  }
  if (signalKind === 'same_error_family') {
    return (
      `[runaway guard] The same tool error family has now occurred ${occurrences} times in ` +
      'a row. Do not retry the same route unchanged. Diagnose the cause, change one controlled ' +
      'variable or switch route. Do not infer that the entire task has failed from this signal.'
    );
  }
  if (signalKind === 'unchanged_progress_repeat') {
    return (
      `[runaway guard] Verified progress for the same work target has remained unchanged across ` +
      `${occurrences} attempts. Do not continue the same route without a concrete expected state ` +
      'change. Inspect the current artifact or state, change strategy, or explain the blocker. ' +
      'Unchanged observed state is not proof that the entire task has failed.'
    );
  }
  return undefined;
}
