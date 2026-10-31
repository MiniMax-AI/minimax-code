import type { PiStepEndHookInput } from '@mavis/agent-core/pi-turn-runner';

export type RunawayGuardSignalKind =
  | 'exact_action_repeat'
  | 'exact_result_repeat'
  | 'same_error_family'
  | 'abab_action_cycle'
  | 'polling_repeat'
  | 'unchanged_progress_repeat';

export type RunawayGuardToolPolicyKind = 'detect' | 'polling' | 'exempt';

export interface RunawayGuardToolStep {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly arguments: unknown;
  readonly result?: {
    /** The result must belong to the assistant call before a tool policy can trust its details. */
    readonly toolName?: string;
    readonly content: unknown;
    readonly details?: unknown;
    readonly isError: boolean;
  };
  readonly verifiedProgress?: RunawayGuardVerifiedToolProgress;
  /** Host-captured execution provenance; absent is never equivalent to a compatibility source. */
  readonly trustedToolProvenance?: RunawayGuardTrustedToolProvenance;
}

/** A bounded host fact captured at actual tool dispatch, never inferred from an assistant message. */
export interface RunawayGuardTrustedToolProvenance {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly source: 'builtin' | 'captured-compatibility';
}

/**
 * Tool-owned, deterministic progress facts. Values are bounded and HMACed before
 * entering StepView; raw keys never leave the Turn or reach observers.
 */
export interface RunawayGuardProgressProjection {
  readonly loopKey: unknown;
  readonly progressKey: unknown;
  readonly newFacts?: number;
  readonly stateChanged?: boolean;
  readonly artifactChanged?: boolean;
  /** Opts a policy into task-scoped polling continuity instead of step-local progress. */
  readonly polling?: RunawayGuardPollingProgressControl;
}

export interface RunawayGuardPollingProgressControl {
  /** A known task either contributes an observation or clears only its own streak. */
  readonly mode: 'continuous' | 'reset';
  /** Only trusted, structured polling observations may consume the shared reminder allowance. */
  readonly reminderEligible?: boolean;
}

/** Host-owned facts that are already structured and verified before StepView projection. */
export interface RunawayGuardVerifiedToolProgress extends RunawayGuardProgressProjection {
  readonly toolCallId: string;
}

export interface RunawayGuardVerifiedProgressRead {
  readonly sessionId: string;
  readonly turnId: string;
  readonly toolCallIds: readonly string[];
}

export interface RunawayGuardReplayStep {
  readonly message: PiStepEndHookInput['message'];
  readonly toolResults: PiStepEndHookInput['toolResults'];
  readonly blockedToolCalls?: PiStepEndHookInput['blockedToolCalls'];
  readonly verifiedProgress?: readonly RunawayGuardVerifiedToolProgress[];
  readonly trustedToolProvenance?: readonly RunawayGuardTrustedToolProvenance[];
}

export interface RunawayGuardReplayInput {
  readonly sessionId: string;
  readonly turnId: string;
  readonly agentName: string;
  readonly steps: readonly RunawayGuardReplayStep[];
  readonly toolPolicies?: Readonly<Record<string, RunawayGuardToolPolicy>>;
  readonly maxFingerprintBytes?: number;
}

export interface RunawayGuardReplayResult {
  readonly observations: readonly RunawayGuardObservation[];
  readonly summary: RunawayGuardTurnSummary;
  readonly metrics: {
    readonly toolCallCount: number;
    readonly providerTokens: number;
    readonly firstSignalStepIndex?: number;
    readonly postSignalStepCount: number;
    readonly postSignalToolCallCount: number;
    readonly postSignalProviderTokens: number;
  };
}

export interface RunawayGuardToolPolicy {
  readonly kind: RunawayGuardToolPolicyKind;
  /** Select stable action identity and omit transport-only arguments such as timeouts. */
  readonly projectActionKey?: (argumentsValue: unknown) => unknown;
  /** Treat a source-owned non-success result as an expected outcome, not an error streak. */
  readonly isExpectedResult?: (step: RunawayGuardToolStep) => boolean;
  /** Supply semantic loop/progress identity from a tool's structured result contract. */
  readonly projectProgress?: (
    step: RunawayGuardToolStep,
  ) => RunawayGuardProgressProjection | undefined;
  /**
   * List the calls this tool made inside one execution (for example PTC
   * run_code children), read only from its trusted structured result, so they
   * count like calls of the same step under their own tool policies.
   */
  readonly projectChildSteps?: (step: RunawayGuardToolStep) => readonly RunawayGuardChildStep[];
}

/** One child call as recorded by its parent tool; there is no result text to inspect. */
export interface RunawayGuardChildStep {
  readonly toolName: string;
  /**
   * Omitted when the parent did not keep this child's arguments. Such a child
   * has no action identity, so it never counts as a repeated call or result.
   */
  readonly arguments?: unknown;
  readonly isError: boolean;
  /** Parent-assigned code of a failed child (for PTC, the PTC_* code). */
  readonly errorCode?: string;
  /**
   * Code the child tool itself reported. With kept arguments it keys the error
   * family like a native call; without them it groups failures across tools.
   */
  readonly toolErrorCode?: string;
}

export interface RunawayGuardObservation {
  readonly schemaVersion: 1;
  readonly sessionId: string;
  readonly turnId: string;
  readonly agentName: string;
  readonly signalKind: RunawayGuardSignalKind;
  readonly stepIndex: number;
  readonly occurrences: number;
}

export interface RunawayGuardSignalSummary {
  readonly episodeCount: number;
  readonly maxOccurrences: number;
  readonly firstStepIndex?: number;
  readonly lastStepIndex?: number;
}

export interface RunawayGuardTurnSummary {
  readonly schemaVersion: 1;
  readonly sessionId: string;
  readonly turnId: string;
  readonly agentName: string;
  readonly stepCount: number;
  readonly projectionSkippedCount: number;
  /** Child calls counted this Turn; shows that run_code Turns are observed at all. */
  readonly childStepsProjected: number;
  readonly reminderInjected: boolean;
  readonly signals: Readonly<Record<RunawayGuardSignalKind, RunawayGuardSignalSummary>>;
}

export interface RunawayGuardOptions {
  readonly toolPolicies?: Readonly<Record<string, RunawayGuardToolPolicy>>;
  readonly maxFingerprintBytes?: number;
  /** Omit for observation-only mode. */
  readonly remindAfterOccurrences?: number;
  readonly onSignal?: (observation: RunawayGuardObservation) => void | Promise<void>;
}

export interface RunawayGuardReminderObservation extends RunawayGuardObservation {
  readonly action: 'steer';
}

export interface RunawayGuardControllerDecision {
  readonly action: 'remind';
  readonly signalKind: RunawayGuardReminderSignalKind;
}

export interface RunawayGuardRunIdentity {
  readonly sessionId: string;
  readonly turnId: string;
  readonly agentName: string;
}

export interface RunawayGuardReminder {
  readonly content: string;
  readonly observation: RunawayGuardReminderObservation;
}

export interface RunawayGuard {
  observe(
    ctx: RunawayGuardRunIdentity,
    step: RunawayGuardReplayStep,
    shouldRemind: boolean,
  ): RunawayGuardReminder | undefined;
  clearDetectionStreaks(ctx: RunawayGuardRunIdentity): void;
  markReminderInjected(ctx: RunawayGuardRunIdentity): void;
  finishTurn(ctx: RunawayGuardRunIdentity): RunawayGuardTurnSummary | undefined;
}

export type RunawayGuardReminderSignalKind = Extract<
  RunawayGuardSignalKind,
  'exact_action_repeat' | 'same_error_family' | 'unchanged_progress_repeat' | 'polling_repeat'
>;

export type ReminderCandidates = ReadonlySet<RunawayGuardReminderSignalKind>;
