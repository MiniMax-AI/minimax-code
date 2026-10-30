import type {
  PiBeforeLlmCallHook,
  PiBeforeToolCallHook,
  PiHistoryChangedHookInput,
  TurnEventReporter,
} from '@mavis/agent-core/pi-turn-runner';
import type { RuntimeEvent } from '@mavis/agent-core/protocol';
import type { AssemblyResult, TurnAssemblyCtx } from '@mavis/agent-runtime';
import type { RuntimeTool } from '@mavis/agent-core/tools';
import type { SessionRecord, UserMessageId } from '../../../session-system/index.js';
import type {
  CanonicalHistoryChange,
  CanonicalHistorySnapshot,
  HistoryReconcileIntent,
} from '../history/contracts.js';
import type {
  AgentExecutionSnapshot,
  AgentHostCanonicalUserInput,
  AgentHostExecutionRequest,
  AgentHostTurnProvenance,
  AgentHostUserInput,
  ContextUsagePromptRange,
  LocalTurnPreparation,
} from '../preparation/contracts.js';
import type { AgentHostPluginHookHandler } from '../plugin-hook-contracts.js';
import type { AgentHostTurnCapabilityView } from '../assembly/turn-capability-lifecycle.js';
import type { PluginHookEventInput } from '@mavis/plugin-hooks';

type BeforeToolCallContext = Parameters<PiBeforeToolCallHook>[0];

export interface AcceptedLeaseBase {
  readonly sessionId: string;
  readonly turnId: string;
  readonly leaseId: string;
  /** Durable accepted order mapped to downstream `turnSequence` fences. */
  readonly acceptedSequence: number;
  /** Exact wall-clock committed with the durable admission receipt. */
  readonly acceptedAtMs: number;
  readonly signal: AbortSignal;
}

/**
 * Shared accepted ownership proof. Its shape intentionally preserves the v2
 * TurnController lease fence without a registry, cast, or object-identity side
 * channel.
 */
export interface AcceptedTurnLease extends AcceptedLeaseBase {
  readonly busyReason: 'turn';
}

export interface AcceptedCompactionLease extends AcceptedLeaseBase {
  readonly busyReason: 'compaction';
}

/** Facts observed by AgentHost while settling one accepted Turn. */
type AgentHostFileChangeObservationKind =
  | 'no_observed_change'
  | 'change_observed'
  | 'uncertain'
  | 'recording_failed';

/**
 * Host-owned observation shape. It records runtime evidence only; product
 * compatibility boundaries decide how to project it into their own contracts.
 */
export interface AgentHostFileChangeObservation {
  readonly fileChange: AgentHostFileChangeObservationKind;
  readonly changedFiles?: readonly string[];
  readonly observationNotes: readonly string[];
}

export interface AgentHostCommittedFacts {
  readonly fileChangeObservation?: AgentHostFileChangeObservation;
  /** Successful task_output reads observed in-process; confirmation is post-commit Host work. */
  readonly backgroundTaskReadCandidates?: readonly string[];
}

export type AgentHostTurnOutcome =
  | {
      readonly status: 'completed';
      /** Durable product wait; settlement must not wake ordinary Queue work. */
      readonly waitingForUser?: true;
      readonly historyReconcile?: HistoryReconcileIntent;
      readonly committedFacts?: AgentHostCommittedFacts;
    }
  | {
      readonly status: 'aborted';
      readonly reason?: string;
      readonly historyReconcile?: HistoryReconcileIntent;
      readonly committedFacts?: AgentHostCommittedFacts;
    }
  | {
      readonly status: 'failed';
      readonly error: unknown;
      readonly committedFacts?: AgentHostCommittedFacts;
    };

/** One product message accepted into the exact active Turn's steering/control buffer. */
export interface AgentHostSteeringMessage {
  /** One Queue claim can carry multiple original user inputs atomically. */
  readonly batchMembers?: readonly AgentHostSteeringMessage[];
  readonly messageKey?: string;
  readonly unconsumedFromTurnIds?: readonly string[];
  readonly unstartedFromTurnIds?: readonly string[];
  readonly queueClaim?: { readonly itemId: string; readonly claimId: string };
  /** Original admission/enqueue wall-clock, retained through requeue and delivery. */
  readonly createdAt?: number;
  readonly producerId: string;
  readonly idempotencyKey: string;
  readonly userMessageId?: UserMessageId;
  /** Queue item identity for send-now steers; keys client-side row reconcile. */
  readonly sourceMessageId?: string;
  /**
   * Explicit model choice stripped by activation-only delivery. Only the
   * exit-boundary requeue reads it; active consumption never applies it.
   */
  readonly requeueModel?: AgentHostUserInput['model'];
  readonly message: AgentHostUserInput;
  readonly genuineUserQueryText: string;
  readonly provenance: AgentHostTurnProvenance;
  readonly delivery?: {
    readonly hideUserMessage?: boolean;
    readonly displayContent?: string;
    readonly displayAttachments?: readonly Readonly<Record<string, unknown>>[];
  };
}

/** Producers whose steering is user-visible work rather than machine delivery. */
const USER_STEERING_PRODUCERS: ReadonlySet<string> = new Set([
  'queue-immediate-send',
  'composer-steer',
  'paused-queue-composer',
]);

/**
 * User steering never extends a finished answer and must survive Turn
 * teardown: the executor defers it at the exit boundary and discard paths
 * requeue it as a fresh query. Non-user producers keep inject/drop semantics.
 */
export function isUserSteeringProducer(producerId: string): boolean {
  return USER_STEERING_PRODUCERS.has(producerId);
}

export type AgentHostCloseResult =
  | { readonly closed: true }
  | {
      readonly closed: false;
      readonly reason: 'stale-lease' | 'steer-pending';
    }
  | {
      readonly closed: false;
      readonly reason: 'aborted';
      readonly abortReason?: string;
    };

/**
 * Turn-owned live control. AgentHost only scopes these callbacks to the
 * accepted Turn; it does not implement ownership, admission, release, or wake.
 */
export interface AgentHostTurnControl {
  /**
   * Binds every execution callback to the exact accepted Session / Turn /
   * lease identity. The returned capability must fail closed after replacement.
   */
  scope(lease: AcceptedTurnLease): AgentHostScopedTurnControl;
}

export interface AgentHostScopedTurnControl {
  /** Drains ordinary product steering accepted before the close fence. */
  readonly drainSteering: () => readonly AgentHostSteeringMessage[];
  /** Snapshot before draining; aborts when new ordinary steering is admitted. */
  readonly steeringSignal?: () => AbortSignal | undefined;
  /** Releases an ordinary claim only after required consumption projection succeeds. */
  readonly ackSteering: (messages: readonly AgentHostSteeringMessage[]) => void;
  /** Restores a failed ordinary claim ahead of newer FIFO input. */
  readonly restoreSteering: (messages: readonly AgentHostSteeringMessage[]) => void;
  readonly tryBeginClose: () => AgentHostCloseResult;
  readonly sealAbnormalTerminal: () => Promise<void>;
  readonly openToolResultTail: () => boolean;
  /**
   * Synchronously closes the tool-tail ingress seam and claims every message
   * admitted before that fence for one tool call.
   */
  readonly closeAndClaimToolResultTail: (toolCallId: string) => readonly AgentHostSteeringMessage[];
  readonly ackToolResultTail: (toolCallId: string) => void;
}

export interface LocalTurnExecutionInput<
  TAgent extends AgentExecutionSnapshot = AgentExecutionSnapshot,
> {
  readonly lease: AcceptedTurnLease;
  readonly request: AgentHostExecutionRequest;
  readonly session: SessionRecord;
  readonly agent: TAgent;
  readonly preparation: LocalTurnPreparation;
  readonly assemblyContext: TurnAssemblyCtx;
  readonly assembly: AssemblyResult;
  readonly history: CanonicalHistorySnapshot;
  /** Provider-facing history; defaults to canonical history for legacy test callers. */
  readonly runnerHistory?: CanonicalHistorySnapshot;
  readonly canonicalUserInput: AgentHostCanonicalUserInput;
  readonly desktopCapabilities?: AgentHostTurnCapabilityView;
  /** Immutable Plugin Hook projection captured with this turn's capability generation. */
  readonly pluginHooks?: readonly AgentHostPluginHookHandler[];
  /** Non-secret protocol metadata frozen once for this Turn's Plugin Hook invocations. */
  readonly pluginHookRuntimeContext?: {
    readonly transcriptPath?: string | null;
    readonly codexTranscriptPath?: string | null;
    readonly model?: string;
    readonly permissionMode?: string;
    readonly effort?: PluginHookEventInput['effort'];
    readonly promptId?: string;
  };
  readonly pluginHookTranscriptWriter?: {
    apply(change: PiHistoryChangedHookInput): Promise<void>;
  };
  /** Turn-owned identity + durable surface for user-visible Hook warnings. */
  readonly pluginHookEventReporter?: TurnEventReporter & {
    /** Present only for the real TUI terminal host. */
    readonly terminalSequenceSurface?: 'tui';
  };
  readonly pluginApprovalRequests?: Map<
    string,
    {
      /** Compatible-compatible PreToolUse permission request. */
      readonly behavior: 'allow' | 'ask';
      readonly reason?: string;
    }
  >;
  /** Exact Plugin MCP ownership captured from this turn's immutable capability generation. */
  readonly pluginMcpToolOwners?: ReadonlyMap<string, string>;
  /** Host-bound hidden targets keyed by the outer gateway call id during admission. */
  readonly pluginHostApprovalTargets?: Map<
    string,
    {
      readonly tool: RuntimeTool;
      readonly inputSchema: RuntimeTool['def']['schema'];
      readonly pluginName: string;
    }
  >;
  readonly pluginHookContext?: string;
  /** Per-turn bridge from durable automatic compaction to the next LLM boundary. */
  /**
   * Non-terminal events resolve after durable delivery. A terminal event is
   * claimed before validation, then copied and staged exactly once.
   */
  readonly onRuntimeEvent: (event: RuntimeEvent) => Promise<void>;
  readonly onHistoryChanged: (change: CanonicalHistoryChange) => Promise<void>;
  /** Registers exact Display identities before Pi appends consumed steering. */
  readonly registerCanonicalUserMessageIds: (
    messageIds: readonly UserMessageId[],
    batchId?: string,
  ) => void;
  /** Retracts the rejected attempt from current canonical artifacts before retrying. */
  readonly recallOutputAttemptHistory?: (attempt: number) => Promise<void>;
  /** Rearms only the logical Turn primary identity after durable attempt recall. */
  readonly rearmPrimaryUserMessageIdAfterOutputRecall: () => void;
  /**
   * Resolves the authoritative Host outcome from the terminal state owned by
   * TurnCommitPipeline. The executor must not keep a second terminal buffer.
   */
  readonly resolveTerminalOutcome: (reconcile?: HistoryReconcileIntent) => AgentHostTurnOutcome;
  /** Host-installed automatic context compaction; absent only in non-production test bags. */
  readonly contextCompactionHook?: PiBeforeLlmCallHook;
  /**
   * Publishes the system-prompt attribution ranges once calibrated against the
   * final system prompt, so compaction can attribute its post-compaction
   * Context Usage estimate to the same components.
   */
  readonly onContextUsagePromptRangesResolved?: (
    ranges: readonly ContextUsagePromptRange[] | undefined,
  ) => void;
  readonly control: AgentHostScopedTurnControl;
}

export interface LocalTurnToolPolicyGuard {
  beforeToolCall(input: {
    readonly plan?: TurnAssemblyCtx['plan'];
    /** Exact visible user-authored query; empty for autonomous and hidden turns. */
    readonly genuineUserQueryText: string;
    readonly toolContext: BeforeToolCallContext;
    readonly signal?: AbortSignal;
  }): ReturnType<PiBeforeToolCallHook>;
}

/**
 * Host-owned output ceiling for turns whose budget the host already settled.
 *
 * Only the fixed Goal verifier child has one today: its parent Goal has
 * already clamped how many tokens this verification attempt may spend, and a
 * cumulative check can at best notice an overrun after the provider produced
 * it. Returning a cap binds it to every provider request of that turn.
 * `undefined` means no host budget applies and the turn keeps the resolved
 * model's own cap unchanged.
 */
export interface LocalTurnOutputTokenCapResolver {
  resolveOutputTokenCap(input: {
    readonly turnIntent?: TurnAssemblyCtx['turnIntent'];
  }): number | undefined;
}

/**
 * Host-owned execution seam. It merges AgentRuntime contributions with host
 * policy, then delegates to the neutral runtime port.
 */
export interface LocalTurnExecutor<TAgent extends AgentExecutionSnapshot = AgentExecutionSnapshot> {
  execute(input: LocalTurnExecutionInput<TAgent>): Promise<AgentHostTurnOutcome>;
  /**
   * Optional. Called by the Host once the Turn's terminal state is durably
   * committed, for work that must not run before that commit succeeded. Must be
   * synchronous, best-effort and must never block the committed Turn.
   */
  afterSuccessfulCommit?(outcome: AgentHostTurnOutcome): void;
}
