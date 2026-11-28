import type {
  ReminderCandidates,
  RunawayGuardObservation,
  RunawayGuardOptions,
  RunawayGuardReminderSignalKind,
  RunawayGuardRunIdentity,
  RunawayGuardSignalKind,
} from './contracts.js';
import type { ProgressView, StepView } from './step-view.js';
import { recordMaxOccurrences, type ProgressStreak, type ShadowState } from './state.js';
import { isReminderSignalKind } from './reminder.js';

interface DetectionSinks {
  readonly ctx: RunawayGuardRunIdentity;
  readonly state: ShadowState;
  readonly observer: RunawayGuardOptions['onSignal'];
}

export function observeStep(
  view: StepView,
  sinks: DetectionSinks,
  remindAfterOccurrences?: number,
): ReminderCandidates {
  const reminderCandidates = new Set<RunawayGuardReminderSignalKind>();
  sinks.state.detectActionStreaks = observeRepeatedKeys(
    sinks.state.detectActionStreaks,
    view.detectActionKeys,
    'exact_action_repeat',
    sinks,
    remindAfterOccurrences,
    true,
    reminderCandidates,
  );
  sinks.state.pollingActionStreaks = observeRepeatedKeys(
    sinks.state.pollingActionStreaks,
    view.pollingActionKeys,
    'polling_repeat',
    sinks,
    remindAfterOccurrences,
    false,
    reminderCandidates,
  );
  sinks.state.detectResultStreaks = observeRepeatedKeys(
    sinks.state.detectResultStreaks,
    view.detectResultKeys,
    'exact_result_repeat',
    sinks,
    remindAfterOccurrences,
    false,
    reminderCandidates,
  );
  sinks.state.errorFamilyStreaks = observeRepeatedKeys(
    sinks.state.errorFamilyStreaks,
    view.errorFamilyKeys,
    'same_error_family',
    sinks,
    remindAfterOccurrences,
    view.remindableErrorFamilyKeys,
    reminderCandidates,
  );
  sinks.state.progressStreaks = observeProgress(
    view.progress,
    sinks,
    remindAfterOccurrences,
    reminderCandidates,
  );
  observeAbab(view.detectActionBatchKey, sinks);
  return reminderCandidates;
}

function observeProgress(
  current: readonly ProgressView[],
  sinks: DetectionSinks,
  remindAfterOccurrences: number | undefined,
  reminderCandidates: Set<RunawayGuardReminderSignalKind>,
): Map<string, ProgressStreak> {
  const previous = sinks.state.progressStreaks;
  const next = new Map<string, ProgressStreak>(
    [...previous].filter(([, streak]) => streak.continuousPolling === true),
  );
  const pollingCandidates = new Set<string>();
  for (const view of current) {
    if (view.type === 'interrupt') {
      for (const [loopKey, streak] of next) {
        if (streak.continuousPolling) next.delete(loopKey);
      }
      pollingCandidates.clear();
      continue;
    }
    if (view.type === 'reset') {
      clearContinuousPolling(next);
      pollingCandidates.clear();
      continue;
    }
    let prior = previous.get(view.loopKey);
    if (view.continuousPolling) {
      if (clearContinuousPolling(next, view.loopKey)) pollingCandidates.clear();
      const continuous = next.get(view.loopKey);
      prior = continuous?.continuousPolling === true ? continuous : undefined;
    }
    if (view.verifiedProgress) {
      next.set(view.loopKey, {
        progressKey: view.progressKey,
        occurrences: 0,
        ...(view.continuousPolling ? { continuousPolling: true } : {}),
        ...(view.reminderEligible ? { reminderEligible: true } : {}),
      });
      pollingCandidates.delete(view.loopKey);
      continue;
    }
    const occurrences = view.continuousPolling
      ? (prior?.occurrences ?? 0) + 1
      : prior?.progressKey === view.progressKey
        ? prior.occurrences + 1
        : 1;
    next.set(view.loopKey, {
      progressKey: view.progressKey,
      occurrences,
      ...(view.continuousPolling ? { continuousPolling: true } : {}),
      ...(view.reminderEligible ? { reminderEligible: true } : {}),
    });
    if (!view.continuousPolling && prior?.progressKey !== view.progressKey) {
      pollingCandidates.delete(view.loopKey);
    }
    const signalKind: RunawayGuardSignalKind =
      view.kind === 'polling' ? 'polling_repeat' : 'unchanged_progress_repeat';
    recordMaxOccurrences(sinks.state, signalKind, occurrences);
    if ((prior?.occurrences ?? 0) < 2 && occurrences >= 2) {
      emitObservation(sinks.observer, sinks.ctx, sinks.state, signalKind, 2);
    }
    if (
      remindAfterOccurrences !== undefined &&
      view.kind === 'detect' &&
      (prior?.occurrences ?? 0) < remindAfterOccurrences &&
      occurrences >= remindAfterOccurrences
    ) {
      addReminderCandidate(reminderCandidates, 'unchanged_progress_repeat');
    }
    if (
      remindAfterOccurrences !== undefined &&
      view.continuousPolling &&
      view.reminderEligible &&
      (prior?.occurrences ?? 0) < remindAfterOccurrences &&
      occurrences >= remindAfterOccurrences
    ) {
      pollingCandidates.add(view.loopKey);
    }
  }
  if (
    remindAfterOccurrences !== undefined &&
    [...pollingCandidates].some((loopKey) => {
      const streak = next.get(loopKey);
      return (
        streak?.continuousPolling === true &&
        streak.reminderEligible === true &&
        streak.occurrences >= remindAfterOccurrences
      );
    })
  ) {
    addReminderCandidate(reminderCandidates, 'polling_repeat');
  }
  return next;
}

function clearContinuousPolling(
  streaks: Map<string, ProgressStreak>,
  exceptLoopKey?: string,
): boolean {
  let cleared = false;
  for (const [loopKey, streak] of streaks) {
    if (!streak.continuousPolling || loopKey === exceptLoopKey) continue;
    streaks.delete(loopKey);
    cleared = true;
  }
  return cleared;
}

function observeRepeatedKeys(
  previous: ReadonlyMap<string, number>,
  current: readonly string[],
  signalKind: RunawayGuardSignalKind,
  sinks: DetectionSinks,
  remindAfterOccurrences: number | undefined,
  reminderEligibility: boolean | ReadonlySet<string>,
  reminderCandidates: Set<RunawayGuardReminderSignalKind>,
): Map<string, number> {
  const counts = occurrenceCounts(current);
  const next = new Map<string, number>();
  for (const [key, count] of counts) {
    const prior = previous.get(key) ?? 0;
    const occurrences = prior + count;
    next.set(key, occurrences);
    recordMaxOccurrences(sinks.state, signalKind, occurrences);
    if (prior < 2 && occurrences >= 2) {
      emitObservation(sinks.observer, sinks.ctx, sinks.state, signalKind, 2);
    }
    if (
      remindAfterOccurrences !== undefined &&
      (reminderEligibility === true ||
        (reminderEligibility !== false && reminderEligibility.has(key))) &&
      prior < remindAfterOccurrences &&
      occurrences >= remindAfterOccurrences
    ) {
      if (isReminderSignalKind(signalKind)) {
        addReminderCandidate(reminderCandidates, signalKind);
      }
    }
  }
  return next;
}

function addReminderCandidate(
  candidates: Set<RunawayGuardReminderSignalKind>,
  signalKind: RunawayGuardReminderSignalKind,
): void {
  candidates.add(signalKind);
}

function observeAbab(current: string | undefined, sinks: DetectionSinks): void {
  if (!current) {
    sinks.state.recentActionBatches = [];
    sinks.state.activeAbabKey = undefined;
    return;
  }
  sinks.state.recentActionBatches.push(current);
  if (sinks.state.recentActionBatches.length > 4) sinks.state.recentActionBatches.shift();
  if (sinks.state.recentActionBatches.length < 4) return;
  const [a, b, c, d] = sinks.state.recentActionBatches;
  if (!a || !b || a === b || a !== c || b !== d) {
    sinks.state.activeAbabKey = undefined;
    return;
  }
  const episode = `${a}\u0000${b}`;
  if (sinks.state.activeAbabKey === episode) return;
  sinks.state.activeAbabKey = episode;
  emitObservation(sinks.observer, sinks.ctx, sinks.state, 'abab_action_cycle', 2);
}

function emitObservation(
  observer: RunawayGuardOptions['onSignal'],
  ctx: RunawayGuardRunIdentity,
  state: ShadowState,
  signalKind: RunawayGuardSignalKind,
  occurrences: number,
): void {
  const stats = state.signalStats[signalKind];
  stats.episodeCount += 1;
  stats.firstStepIndex ??= state.stepIndex;
  stats.lastStepIndex = state.stepIndex;
  recordMaxOccurrences(state, signalKind, occurrences);
  if (!observer) return;
  const observation: RunawayGuardObservation = {
    schemaVersion: 1,
    sessionId: ctx.sessionId,
    turnId: ctx.turnId,
    agentName: ctx.agentName,
    signalKind,
    stepIndex: state.stepIndex,
    occurrences,
  };
  notifyBestEffort(observer, observation);
}

function notifyBestEffort<T>(
  observer: ((observation: T) => void | Promise<void>) | undefined,
  observation: T,
): void {
  if (!observer) return;
  try {
    Promise.resolve(observer(observation)).catch(() => undefined);
  } catch {
    // Observer failures are intentionally disconnected from Turn execution.
  }
}

function occurrenceCounts(values: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}
