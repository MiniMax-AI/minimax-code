import { randomBytes } from 'node:crypto';
import type {
  RunawayGuardRunIdentity,
  RunawayGuardSignalKind,
  RunawayGuardTurnSummary,
} from './contracts.js';

export interface ProgressStreak {
  readonly progressKey: string;
  readonly occurrences: number;
  /** Continuous task polling persists across text and reads of other tasks. */
  readonly continuousPolling?: boolean;
  readonly reminderEligible?: boolean;
}

export interface ShadowState {
  readonly secret: Buffer;
  stepIndex: number;
  fingerprintSkippedCount: number;
  childStepsProjected: number;
  reminderAttempted: boolean;
  reminderInjected: boolean;
  readonly signalStats: Record<RunawayGuardSignalKind, MutableSignalStats>;
  detectActionStreaks: Map<string, number>;
  pollingActionStreaks: Map<string, number>;
  detectResultStreaks: Map<string, number>;
  errorFamilyStreaks: Map<string, number>;
  progressStreaks: Map<string, ProgressStreak>;
  recentActionBatches: string[];
  activeAbabKey?: string;
}

interface MutableSignalStats {
  episodeCount: number;
  maxOccurrences: number;
  firstStepIndex?: number;
  lastStepIndex?: number;
}

export function clearDetectionStreaks(state: ShadowState): void {
  state.detectActionStreaks.clear();
  state.pollingActionStreaks.clear();
  state.detectResultStreaks.clear();
  state.errorFamilyStreaks.clear();
  state.progressStreaks.clear();
  state.recentActionBatches = [];
  state.activeAbabKey = undefined;
}

export function recordMaxOccurrences(
  state: ShadowState,
  signalKind: RunawayGuardSignalKind,
  occurrences: number,
): void {
  const stats = state.signalStats[signalKind];
  stats.maxOccurrences = Math.max(stats.maxOccurrences, occurrences);
}

export function snapshotTurnSummary(
  ctx: RunawayGuardRunIdentity,
  state: ShadowState,
): RunawayGuardTurnSummary {
  return {
    schemaVersion: 1,
    sessionId: ctx.sessionId,
    turnId: ctx.turnId,
    agentName: ctx.agentName,
    stepCount: state.stepIndex,
    projectionSkippedCount: state.fingerprintSkippedCount,
    childStepsProjected: state.childStepsProjected,
    reminderInjected: state.reminderInjected,
    signals: snapshotSignalStats(state.signalStats),
  };
}

function snapshotSignalStats(
  stats: ShadowState['signalStats'],
): RunawayGuardTurnSummary['signals'] {
  return {
    exact_action_repeat: { ...stats.exact_action_repeat },
    exact_result_repeat: { ...stats.exact_result_repeat },
    same_error_family: { ...stats.same_error_family },
    abab_action_cycle: { ...stats.abab_action_cycle },
    polling_repeat: { ...stats.polling_repeat },
    unchanged_progress_repeat: { ...stats.unchanged_progress_repeat },
  };
}

export function stateFor(
  states: Map<string, ShadowState>,
  ctx: RunawayGuardRunIdentity,
): ShadowState {
  const key = runKey(ctx);
  const existing = states.get(key);
  if (existing) return existing;
  const state = newShadowState();
  states.set(key, state);
  return state;
}

export function newShadowState(): ShadowState {
  return {
    secret: randomBytes(32),
    stepIndex: 0,
    fingerprintSkippedCount: 0,
    childStepsProjected: 0,
    reminderAttempted: false,
    reminderInjected: false,
    signalStats: createSignalStats(),
    detectActionStreaks: new Map(),
    pollingActionStreaks: new Map(),
    detectResultStreaks: new Map(),
    errorFamilyStreaks: new Map(),
    progressStreaks: new Map(),
    recentActionBatches: [],
  };
}

function createSignalStats(): ShadowState['signalStats'] {
  return {
    exact_action_repeat: emptySignalStats(),
    exact_result_repeat: emptySignalStats(),
    same_error_family: emptySignalStats(),
    abab_action_cycle: emptySignalStats(),
    polling_repeat: emptySignalStats(),
    unchanged_progress_repeat: emptySignalStats(),
  };
}

function emptySignalStats(): MutableSignalStats {
  return { episodeCount: 0, maxOccurrences: 0 };
}

export function runKey(ctx: Pick<RunawayGuardRunIdentity, 'sessionId' | 'turnId'>): string {
  return `${ctx.sessionId}\u0000${ctx.turnId}`;
}
